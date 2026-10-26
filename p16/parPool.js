/**
 * 多线程模拟：网格按**行**静态分成 T 段（T 由核数定），每个线程负责一段：
 * 第 0 段在模拟宿主（sim.worker）自己的线程里算，第 1..T−1 段在帮手线程（par.worker）里算。
 * 画面不在这里：模拟宿主算完一帧照旧把数据发给主线程画（见 simHost.ts，两份缓冲锁步）。
 *
 * 不用合并：所有状态都在一块 SharedArrayBuffer 里（布局见 engineBlob 的 memSpec），每个线程用同一块内存
 * 各建一个 FluidEngineBlob —— 数组是同一份。第 63 行的水块挪进第 64 行，就是第 0 段的线程直接往
 * newm[64·W + i] 里加；第 64 行那段的线程下一个阶段读到的就是加好的值。
 *
 * 一步分成几个阶段（压力、力、挪水块、动量、新水块、新速度），每个阶段大家各算自己那段，做完等齐（栅栏）。
 * 栅栏之后，前一阶段任何线程写的东西所有线程都看得到（Atomics 读写有先后）。
 * 墙、速度封顶这几件整张图的小事在两个阶段之间由宿主一个人做。
 *
 * 只有两个阶段会往**相邻一行**里写：挪水块（水块落进上下的格）、动量（搬到上下的面）。
 * 相邻两段同时算这两个阶段，段边上那一行会被两个线程同时写（同时 += 会丢掉一份）。
 * 所以这两个阶段分两趟：每段对半分成前半、后半；先所有段的前半、等齐，再所有段的后半。
 * 同时算的两个半段之间隔着一个半段（≥ SUB_MIN 行），写不到同一行 —— 结果确定，不用原子加、不用合并。
 * 和单线程比只是段边上几格加起来的顺序不同，差在最后一位。
 *
 * 控制块（Int32Array）：
 *   [0] 第几次开工（递增；帮手 Atomics.wait 在这里）  [1] 还没做完的帮手数  [2] 阶段号  [3] 退出
 *   [4] 颜色（分两趟的阶段：0 = 前半，1 = 后半）  [5..] 每段起始行（T+1 个）、每个半段起始行（2T+1 个）
 *   [..] 线程数、报到数、出错标记
 *   Float64Array（紧跟在后面）：StepCtx 的 9 个数、每个半段的 diagBuf 结束位置、每段的 |u| / |v| 最大值
 */
import { FluidEngineBlob, sharedBytes } from "./engineBlob.js";
/** 最多几个线程（含宿主） */
export const MAX_T = 16;
/**
 * 半段至少几行：同时算的两个半段之间隔着一个半段，挪水块 / 动量最多写到相邻 1 行（面行再多 1），隔 4 行够了。
 * 一段 = 两个半段，所以一段至少 8 行
 */
const SUB_MIN = 4;
const MIN_ROWS = 2 * SUB_MIN;
/**
 * 段怎么分：
 *   false = 静态：平均分行，整个运行不变（第 b 段 = 第 b·H/T 行到第 (b+1)·H/T 行）
 *   true  = 每步按各行的水量重新分（水只在底部几行时也摊给所有线程；分一次约 2 µs）
 */
const BALANCE = false;
/** 阶段号 */
const PH = {
    pressure: 1,
    force: 2,
    move: 3, // 分两趟
    momentum: 4, // 分两趟
    refit: 5,
    vel: 6,
};
const C_GEN = 0, C_LEFT = 1, C_PHASE = 2, C_QUIT = 3, C_COLOR = 4, C_BANDS = 5, // MAX_T + 1 个
C_SUB = C_BANDS + MAX_T + 1, // 2·MAX_T + 1 个
C_THREADS = C_SUB + 2 * MAX_T + 1, C_READY = C_THREADS + 1, // 热身完、开始等活的帮手数（各自 Atomics.add 1）
C_DEAD = C_READY + 1; // 有帮手在活里抛了异常
const CTRL_INTS = C_DEAD + 1;
const F_CTX = 0, // 9 个
F_DEND = 9, // 2·MAX_T 个（每个半段）
F_UMAX = F_DEND + 2 * MAX_T, F_VMAX = F_UMAX + MAX_T;
const CTRL_F64 = F_VMAX + MAX_T;
/** 忙等多少次再睡：核不够时忙等的线程占着别的线程要用的核，所以只忙等一小会儿 */
const SPIN = 400;
/** 栅栏最多等多久（ms）：帮手被浏览器停掉 / 不调度时，不能让模拟永远卡住 */
const BARRIER_MS = 1500;
/** 帮手多久还没报到就放弃多线程（ms；热身大约 0.4 秒） */
const READY_TIMEOUT_MS = 8000;
/** 能不能用多线程：要 SharedArrayBuffer、Atomics，页面要跨源隔离（服务器发 COOP / COEP 头） */
export function parAvailable() {
    const g = globalThis;
    return typeof g.SharedArrayBuffer === "function" && g.crossOriginIsolated === true && typeof Atomics !== "undefined";
}
/** 用几个线程算模拟（含宿主）：留两个核给主线程画画面和浏览器自己，1..MAX_T */
export function pickThreads(cores) {
    return Math.max(1, Math.min(MAX_T, cores - 2));
}
function ctrlBytes() {
    return Math.ceil((CTRL_INTS * 4) / 8) * 8 + CTRL_F64 * 8;
}
function views(ctrl) {
    const off = Math.ceil((CTRL_INTS * 4) / 8) * 8;
    return { I: new Int32Array(ctrl, 0, CTRL_INTS), F: new Float64Array(ctrl, off, CTRL_F64) };
}
function readCtx(F) {
    return {
        dt: F[F_CTX], m0: F[F_CTX + 1], c: F[F_CTX + 2], g: F[F_CTX + 3], vCap: F[F_CTX + 4],
        k1: F[F_CTX + 5], kv: F[F_CTX + 6], kw: F[F_CTX + 7], kn: F[F_CTX + 8],
    };
}
function writeCtx(F, x) {
    F[F_CTX] = x.dt;
    F[F_CTX + 1] = x.m0;
    F[F_CTX + 2] = x.c;
    F[F_CTX + 3] = x.g;
    F[F_CTX + 4] = x.vCap;
    F[F_CTX + 5] = x.k1;
    F[F_CTX + 6] = x.kv;
    F[F_CTX + 7] = x.kw;
    F[F_CTX + 8] = x.kn;
}
/** 斜着走的水块记在 diagBuf 里：每个半段从它的起始行开始用（每格最多 4 块 × 3 个数，互不重叠） */
function diagStart(e, j0) {
    return j0 * e.w * 12;
}
/** 第 band 段做当前阶段（宿主和帮手共用） */
function runPhase(e, I, F, band) {
    const j0 = I[C_BANDS + band], j1 = I[C_BANDS + band + 1];
    if (j1 <= j0)
        return;
    const x = readCtx(F);
    switch (I[C_PHASE]) {
        case PH.pressure:
            e.phasePressure(x, j0, j1);
            return;
        case PH.force:
            e.phaseForce(x, j0, j1);
            F[F_UMAX + band] = e.maxU;
            F[F_VMAX + band] = e.maxV;
            return;
        case PH.move: {
            const sb = 2 * band + I[C_COLOR], s0 = I[C_SUB + sb], s1 = I[C_SUB + sb + 1];
            F[F_DEND + sb] = s1 > s0 ? e.moveBlocks(x.dt, x.m0, s0, s1, diagStart(e, s0)) : diagStart(e, s0);
            return;
        }
        case PH.momentum: {
            const sb = 2 * band + I[C_COLOR], s0 = I[C_SUB + sb], s1 = I[C_SUB + sb + 1];
            if (s1 > s0)
                e.phaseMomentum(x, s0, s1, diagStart(e, s0), F[F_DEND + sb]);
            return;
        }
        case PH.refit:
            e.refitBlocks(j0, j1, x.m0);
            return;
        case PH.vel:
            e.phaseVel(x, j0, j1);
            F[F_UMAX + band] = e.maxU;
            F[F_VMAX + band] = e.maxV;
            return;
    }
}
/** 帮手线程的主循环（par.worker 里调用）：睡在栅栏上，被叫醒就算自己那一段，做完报一声 */
export function helperLoop(m) {
    const e = new FluidEngineBlob(m.w, m.h, m.state);
    const { I, F } = views(m.ctrl);
    Atomics.add(I, C_READY, 1); // 报到：宿主等所有帮手都报到了才开始分活
    // 从 0 开始数：起得晚、宿主已经叫过一次的话马上就去做，不会错过
    let seen = 0;
    for (;;) {
        let g = Atomics.load(I, C_GEN);
        for (let k = 0; g === seen && k < SPIN; k++)
            g = Atomics.load(I, C_GEN);
        if (g === seen)
            Atomics.wait(I, C_GEN, seen);
        seen = Atomics.load(I, C_GEN);
        if (Atomics.load(I, C_QUIT))
            return;
        try {
            runPhase(e, I, F, m.band);
        }
        catch (err) {
            // 不管怎样都要报"做完了"，不然宿主在栅栏上等一辈子
            Atomics.store(I, C_DEAD, 1);
            console.error("帮手线程出错", err);
        }
        if (Atomics.sub(I, C_LEFT, 1) === 1)
            Atomics.notify(I, C_LEFT);
    }
}
/**
 * 宿主这边：一台共享内存上的引擎 + T−1 个帮手线程。step() 是同步的：返回时这一步算完了。
 * 帮手还没报到、出了错、卡住了，就宿主一个人算（单线程），永远不会卡死
 */
export class ParPool {
    engine;
    threads;
    I;
    F;
    workers = [];
    weights;
    H;
    onError;
    ready = false;
    born = performance.now();
    failed = "";
    constructor(w, h, threads, spawn, onError = () => { }) {
        this.H = h;
        this.onError = onError;
        // 一段至少 MIN_ROWS 行：网格太小时少用几个线程
        const T = Math.max(1, Math.min(threads, MAX_T, Math.floor(h / MIN_ROWS)));
        this.threads = T;
        const state = new SharedArrayBuffer(sharedBytes(w, h));
        const ctrl = new SharedArrayBuffer(ctrlBytes());
        this.engine = new FluidEngineBlob(w, h, state);
        const v = views(ctrl);
        this.I = v.I;
        this.F = v.F;
        this.weights = new Float64Array(h);
        this.I[C_THREADS] = T;
        this.setBands(null);
        for (let b = 1; b < T; b++) {
            const wk = spawn();
            this.watch(wk);
            const msg = { t: "init", w, h, state, ctrl, band: b };
            wk.postMessage(msg);
            this.workers.push(wk);
        }
    }
    /** 现在实际在用几个线程（帮手还没报到 / 出错 / 卡住时是 1） */
    get active() {
        return this.allReady() ? this.threads : 1;
    }
    /** 多线程为什么没用上（用上了是空字符串） */
    get why() {
        return this.failed;
    }
    fail(why) {
        if (this.failed)
            return;
        this.failed = why;
        this.onError(why);
    }
    watch(wk) {
        const w = wk;
        const msgOf = (e) => {
            const x = e;
            return (x && (x.message || x.filename)) || String(e);
        };
        if (w.addEventListener)
            w.addEventListener("error", (e) => this.fail("帮手线程出错：" + msgOf(e)));
        else if (w.on)
            w.on("error", (e) => this.fail("帮手线程出错：" + msgOf(e)));
    }
    allReady() {
        if (this.failed)
            return false;
        if (Atomics.load(this.I, C_DEAD)) {
            this.fail("帮手线程算的时候出错了（详见控制台）");
            return false;
        }
        if (this.ready)
            return true;
        const want = this.threads - 1;
        if (Atomics.load(this.I, C_READY) >= want)
            return (this.ready = true);
        if (performance.now() - this.born > READY_TIMEOUT_MS)
            this.fail(`帮手线程 ${READY_TIMEOUT_MS / 1000} 秒还没起来（报到 ${Atomics.load(this.I, C_READY)}/${want}）`);
        return false;
    }
    /**
     * 分段：wt = null 平均分（静态），否则按每行的工作量分（每段至少 MIN_ROWS 行）。
     * 每段再分成前半、后半（各至少 SUB_MIN 行），给分两趟的阶段用
     */
    setBands(wt) {
        const { I, H } = this;
        const T = this.threads;
        I[C_BANDS] = 0;
        I[C_BANDS + T] = H;
        if (!wt) {
            for (let b = 1; b < T; b++)
                I[C_BANDS + b] = Math.round((b * H) / T);
        }
        else {
            let tot = 0;
            for (let j = 0; j < H; j++)
                tot += wt[j];
            let acc = 0, b = 1, last = 0;
            for (let j = 0; j < H && b < T; j++) {
                acc += wt[j];
                if (acc >= (b * tot) / T && j + 1 - last >= MIN_ROWS && H - (j + 1) >= (T - b) * MIN_ROWS) {
                    I[C_BANDS + b] = j + 1;
                    last = j + 1;
                    b++;
                }
            }
            for (; b < T; b++) {
                last = Math.max(last + MIN_ROWS, H - (T - b) * MIN_ROWS);
                I[C_BANDS + b] = last;
            }
        }
        for (let b = 0; b < T; b++) {
            const j0 = I[C_BANDS + b], j1 = I[C_BANDS + b + 1];
            let mid = (j0 + j1) >> 1;
            if (wt) {
                let tot = 0;
                for (let j = j0; j < j1; j++)
                    tot += wt[j];
                let acc = 0;
                mid = j0;
                while (mid < j1 && acc + wt[mid] <= tot / 2)
                    acc += wt[mid++];
            }
            mid = Math.min(Math.max(mid, j0 + SUB_MIN), j1 - SUB_MIN);
            I[C_SUB + 2 * b] = j0;
            I[C_SUB + 2 * b + 1] = mid;
        }
        I[C_SUB + 2 * T] = H;
    }
    /** 所有段做一个阶段（宿主自己做第 0 段），等大家都做完。等不到（帮手卡死）返回 false */
    run(ph, color = 0) {
        const { I, F } = this;
        const T = this.threads;
        I[C_PHASE] = ph;
        I[C_COLOR] = color;
        Atomics.store(I, C_LEFT, T - 1);
        Atomics.add(I, C_GEN, 1);
        Atomics.notify(I, C_GEN);
        runPhase(this.engine, I, F, 0);
        let spins = 0;
        const t0 = performance.now();
        for (;;) {
            const left = Atomics.load(I, C_LEFT);
            if (left === 0)
                return true;
            if (++spins < SPIN)
                continue;
            if (Atomics.wait(I, C_LEFT, left, 20) === "timed-out" && performance.now() - t0 > BARRIER_MS) {
                this.fail(`帮手线程 ${BARRIER_MS / 1000} 秒没做完（还差 ${left} 个），改成单线程`);
                return false;
            }
        }
    }
    /** 走一步 */
    step() {
        const e = this.engine;
        const { F } = this;
        const T = this.threads;
        const x = e.prepare(e.timeStep);
        writeCtx(F, x);
        if (T === 1 || !this.allReady()) {
            this.runAlone(x);
            return;
        }
        if (BALANCE) {
            e.rowWeights(this.weights);
            this.setBands(this.weights);
        }
        if (!this.run(PH.pressure))
            return this.finishAlone(x, PH.pressure);
        if (!this.run(PH.force))
            return this.finishAlone(x, PH.force);
        let mu = 0, mv = 0;
        for (let b = 0; b < T; b++) {
            mu = Math.max(mu, F[F_UMAX + b]);
            mv = Math.max(mv, F[F_VMAX + b]);
        }
        e.clampPhase(x, true, mu, mv);
        const rest = [[PH.move, 0], [PH.move, 1], [PH.momentum, 0], [PH.momentum, 1], [PH.refit, 0], [PH.vel, 0]];
        for (const [ph, c] of rest)
            if (!this.run(ph, c))
                return this.finishAlone(x, ph);
        mu = mv = 0;
        for (let b = 0; b < T; b++) {
            mu = Math.max(mu, F[F_UMAX + b]);
            mv = Math.max(mv, F[F_VMAX + b]);
        }
        e.clampPhase(x, false, mu, mv);
        e.stepCount++;
    }
    /** 宿主一个人整张算（和单线程引擎逐位相同） */
    runAlone(x) {
        const e = this.engine, H = this.H;
        e.phasePressure(x, 0, H);
        e.phaseForce(x, 0, H);
        e.clampPhase(x, true, e.maxU, e.maxV);
        const nD = e.moveBlocks(x.dt, x.m0, 0, H, 0);
        e.phaseMomentum(x, 0, H, 0, nD);
        e.refitBlocks(0, H, x.m0);
        e.phaseVel(x, 0, H);
        e.clampPhase(x, false, e.maxU, e.maxV);
        e.stepCount++;
    }
    /**
     * 帮手卡死后，宿主从阶段 ph 起自己把这一步整张算完（之后一直单线程）。
     * 卡住的阶段帮手可能算了一半：挪水块、动量先把工作区清零再整张重来；力那一阶段按速度重算动量
     * （这一步少一次力，不会多）。这一步不精确，但质量守恒、不会卡住
     */
    finishAlone(x, ph) {
        const e = this.engine, H = this.H;
        if (ph <= PH.pressure)
            e.phasePressure(x, 0, H);
        if (ph <= PH.force) {
            if (ph === PH.force)
                e.momentumFromVelocity();
            else
                e.phaseForce(x, 0, H);
            e.clampPhase(x, true, Infinity, Infinity);
        }
        if (ph <= PH.move) {
            e.clearMoveScratch();
            e.clearMomentumScratch();
            const nD = e.moveBlocks(x.dt, x.m0, 0, H, 0);
            e.phaseMomentum(x, 0, H, 0, nD);
        }
        else if (ph === PH.momentum) {
            e.clearMomentumScratch();
            e.phaseMomentum(x, 0, H, 0, 0);
            for (let sb = 0; sb < 2 * this.threads; sb++) {
                const s0 = this.I[C_SUB + sb];
                e.phaseMomentum(x, 0, 0, diagStart(e, s0), this.F[F_DEND + sb]);
            }
        }
        if (ph <= PH.refit)
            e.refitBlocks(0, H, x.m0);
        e.phaseVel(x, 0, H);
        e.clampPhase(x, false, Infinity, Infinity);
        e.stepCount++;
    }
    dispose() {
        if (this.threads > 1) {
            Atomics.store(this.I, C_QUIT, 1);
            Atomics.add(this.I, C_GEN, 1);
            Atomics.notify(this.I, C_GEN);
        }
        for (const w of this.workers)
            w.terminate();
        this.workers.length = 0;
    }
}
