/**
 * 模拟宿主：拥有引擎、按自己的时钟推进，把画面要用的数据打包发给主线程。
 * 和传输方式无关 —— sim.worker.ts 把它放进 Web Worker（模拟和渲染并行），
 * 没有 Worker 时 simClient 直接在主线程里用它（同一套消息）。
 *
 * 两个线程：模拟（这里，Web Worker）和渲染（主线程），用**两份缓冲**交接，一帧一帧锁步走：
 *   - 一帧 = 连着算 round(8·speed) 步（速度滑杆：0.125× = 1 步，1× = 8 步，2× = 16 步），算完把画面要用的数据
 *     （质量、密度、格类型）拷进一份缓冲，发给主线程（数组随消息转移，不共享）。
 *   - 主线程每次刷新看有没有算好的帧：没有就等（这次不画）；有就按顺序画最早的那一帧，画完把那份缓冲还回来（ack）。
 *   - 两份缓冲：主线程画第 N 帧时，模拟可以算第 N+1 帧、放进另一份。第 N+1 帧算完了、第 N 帧还没画完 ——
 *     两份都不在模拟手里，模拟就等，第 N 帧还回来才开始算第 N+2 帧。所以模拟最多领先一帧，每一帧都会被画出来。
 * 每算完一帧就让出来处理消息（画笔、暂停……），画笔在下一帧里就看得到。
 * 暂停时不走步：改了东西（画笔、参数、单步……）就发一帧，同样要有空的缓冲。
 *
 * 多线程模拟（页面跨源隔离、核数够时）：每一步按行分成几段，这个线程和几个帮手线程各算一段（见 parPool.ts）。
 * 画面还是在主线程画，照旧锁步。
 */
// 换引擎只改这一行 import（原来在 controller.ts）：
//   FluidEngineBlob = 边速度 + 每格水块追踪 —— 修一阶迎风的数值扩散：水块没真的走到格子边，下一格就拿不到水。
//                     一格水下落 400 步仍是 1 格，方块平移精确。
//   其它引擎（engineSimple / engineFlux / engineMix …）接口相同，但没有 renderBlocks / probe 的水块信息
import { FluidEngineBlob as ActiveEngine } from "./engineBlob";
import { ParPool } from "./parPool";
import type { CellProbe } from "./engineBlob";
import { CELL_WALL, CELL_SOURCE } from "./engine";
import type { SimParams } from "./engine";
import { applyPreset } from "./presets";
import type { PresetKey } from "./presets";
import type { Tool } from "./controller";

/** 主线程 → 宿主 */
export type SimIn =
  /** threads：算模拟用几个线程（1 = 只有这一个；多线程要跨源隔离，主线程判断好了再给） */
  | { t: "init"; gen: number; size: number; params: SimParams; preset: PresetKey | ""; blocks: boolean; threads: number }
  | { t: "run"; on: boolean }
  | { t: "speed"; v: number }
  | { t: "param"; key: keyof SimParams; v: number }
  | { t: "preset"; preset: PresetKey }
  | { t: "clear" }
  | { t: "stroke" }
  | { t: "paint"; tool: Tool; pts: number[]; r: number }
  | { t: "step" }
  | { t: "probe"; x: number; y: number }
  /**
   * 画完（或丢掉）了一帧；把那一帧的数组还回来（宿主下一帧直接复用，不每帧分配 1 MB、不触发 GC）。
   * gen：那一帧是第几次 init 的 —— 旧网格的 ack 不算进在路上的帧数
   */
  | { t: "ack"; gen: number; back?: FrameBufs };

/** 一帧的数组（来回转移，复用） */
export interface FrameBufs {
  mass: Float32Array;
  rho: Float32Array;
  kind: Uint8Array;
  blocks: Float32Array | null;
}

/** 宿主 → 主线程：一帧画面要用的全部数据（数组都是拷贝，随消息转移，不共享） */
export interface SimFrame {
  t: "frame";
  /** 第几次 init：主线程换过网格后，旧网格的帧直接丢掉 */
  gen: number;
  w: number;
  h: number;
  mass: Float32Array;
  rho: Float32Array;
  kind: Uint8Array;
  blocks: Float32Array | null;
  steps: number;
  totalMass: number;
  /** 底部 5 行的总质量（临时读数） */
  floor: number;
  probe: CellProbe | null;
  /** 最近一步花了多少 ms（滑动平均，诊断用：FPS 低是模拟慢还是渲染慢） */
  stepMs: number;
  /** 实际在用几个线程算模拟（帮手还没起来 / 出错时是 1） */
  threads: number;
  /** 多线程没用上的原因（空 = 没问题） */
  why: string;
}

/** 每帧几步（速度 1×）：每帧步数 = 8 × 速度（0.125× = 1 步，2× = 16 步） */
const STEPS_PER_FRAME = 8;
/** 两份缓冲：最多两帧在主线程手里（一帧在画、一帧等着画） */
const BUFFERS = 2;

export type Post = (f: SimFrame, transfer: Transferable[]) => void;
/** 开一个帮手线程（浏览器：new Worker(par.worker.ts)；node 测试：worker_threads） */
export type Spawn = () => Worker;
export type Schedule = (fn: () => void, ms: number) => void;

/**
 * 0 延迟用 MessageChannel（setTimeout(0) 连着用会被浏览器夹到 4 ms）。
 * node 里（测试）用 setImmediate：node 的 MessagePort 会连着处理自己刚发的消息，把定时器饿死
 */
export function makeScheduler(): Schedule {
  const si = (globalThis as { setImmediate?: (fn: () => void) => unknown }).setImmediate;
  if (typeof si === "function") return (fn, ms) => (ms > 0 ? setTimeout(fn, ms) : si(fn));
  if (typeof MessageChannel !== "undefined") {
    // 排着的回调一个都不能丢：原来只记最后一个，连着排两个时前一个被顶掉 ——
    // 宿主开场先发第 0 帧、再排第一次 tick，tick 丢了就再也不走（浏览器里画布一片空）
    const ch = new MessageChannel();
    const q: (() => void)[] = [];
    ch.port1.onmessage = () => {
      const f = q.shift();
      if (f) f();
    };
    return (fn, ms) => {
      if (ms > 0) setTimeout(fn, ms);
      else {
        q.push(fn);
        ch.port2.postMessage(0);
      }
    };
  }
  return (fn, ms) => setTimeout(fn, ms);
}

/**
 * JIT 热身：开场先在几个小网格上把各种情况走一遍（溃坝撞墙、墙柱、斜墙、水源、高压格、画笔 / 橡皮），
 * 让引擎的代码在小网格上就编译好、见过所有分支。
 * 不热身的话，大网格开场前几步每步 50–110 ms，之后每遇到一种第一次出现的情况，优化代码作废重编，
 * 那一步又卡 50 ms（256×256 溃坝在第 180、200 步各卡一次）。热身约 0.4 秒，只做一次
 */
function warmUp(): void {
  const N = 48;
  for (const p of ["dam", "twin", "rain", "hourglass"] as const) {
    const e = new ActiveEngine(N, N);
    applyPreset(e, p);
    for (let j = 34; j < N; j++) e.kind[j * N + 30] = CELL_WALL;
    for (let k = 0; k < 8; k++) e.kind[(N - 1 - k) * N + 36 + k] = CELL_WALL;
    e.kind[2 * N + 40] = CELL_SOURCE;
    e.mass[10 * N + 38] = 8;
    for (let s = 0; s < 120; s++) {
      e.step();
      if (s === 60) {
        e.beginStroke();
        e.paintLiquid(24, 8, 2);
        e.paintErase(10, 40, 1);
      }
    }
    e.renderDensity();
    e.probe(10, 40);
  }
}

export class SimHost {
  private readonly post: Post;
  private readonly schedule: Schedule;
  private readonly spawn: Spawn | null;
  private engine: ActiveEngine | null = null;
  /** 多线程时的帮手线程池（engine 就是 pool.engine） */
  private pool: ParPool | null = null;
  /** 多线程没用上的原因 */
  private why = "";
  private gen = 0;
  private blocks = false;
  private running = true;
  /** 每帧几步 */
  private perFrame = STEPS_PER_FRAME;
  /** 发出去还没还回来的帧数（= 两份缓冲里在主线程手里的份数） */
  private inFlight = 0;
  /** 上一帧之后状态又变过（暂停时画笔、参数……）还没发 */
  private dirty = false;
  private probeX = -1;
  private probeY = -1;
  /** 有没有排好的 tick（不重复排） */
  private ticking = false;
  /** 主线程还回来的缓冲（尺寸对得上就复用） */
  private spare: FrameBufs[] = [];
  /** 热身过了吗（只在第一次 init 前做一次） */
  private warmed = false;
  /** 一步的耗时（ms，滑动平均） */
  private stepMs = 0;

  constructor(post: Post, schedule: Schedule, spawn: Spawn | null = null) {
    this.post = post;
    this.schedule = schedule;
    this.spawn = spawn;
  }

  handle(m: SimIn): void {
    const e = this.engine;
    switch (m.t) {
      case "init": {
        if (!this.warmed) {
          this.warmed = true;
          warmUp();
        }
        if (this.pool) {
          this.pool.dispose();
          this.pool = null;
        }
        if (m.threads > 1 && this.spawn) {
          try {
            this.pool = new ParPool(m.size, m.size, m.threads, this.spawn, (why) => (this.why = why));
            this.why = "";
          } catch (err) {
            this.pool = null;
            this.why = "开不了帮手线程：" + String((err as Error)?.message ?? err);
          }
        }
        const ne = this.pool ? this.pool.engine : new ActiveEngine(m.size, m.size);
        ne.params = { ...m.params };
        if (m.preset) applyPreset(ne, m.preset);
        this.engine = ne;
        this.gen = m.gen;
        this.blocks = m.blocks;
        this.inFlight = 0; // 新网格：旧网格的帧不算了（它们的 ack 带的是旧 gen）
        this.spare.length = 0;
        // 第 0 帧（开场的样子），然后开始一帧一帧算
        this.dirty = true;
        this.publish();
        this.kick();
        return;
      }
      case "run":
        this.running = m.on;
        if (m.on) this.kick();
        return;
      case "speed":
        this.perFrame = Math.max(1, Math.round(STEPS_PER_FRAME * m.v));
        return;
      case "ack":
        if (m.gen !== this.gen) return;
        if (m.back && this.spare.length < BUFFERS) this.spare.push(m.back);
        if (this.inFlight > 0) this.inFlight--;
        // 空出一份缓冲：在跑就接着算下一帧；暂停时有没发的改动就发
        if (this.running) this.kick();
        else if (this.dirty) this.publish();
        return;
    }
    if (!e) return;
    switch (m.t) {
      case "param":
        e.params[m.key] = m.v;
        break; // 暂停时读数（压力）也跟着变
      case "preset":
        applyPreset(e, m.preset);
        break;
      case "clear":
        e.clear();
        break;
      case "stroke":
        e.beginStroke();
        return;
      case "paint":
        for (let k = 0; k + 1 < m.pts.length; k += 2) {
          const x = m.pts[k],
            y = m.pts[k + 1];
          if (m.tool === "liquid") e.paintLiquid(x, y, m.r);
          else if (m.tool === "wall") e.paintWall(x, y, m.r);
          else if (m.tool === "eraser") e.paintErase(x, y, m.r);
          else e.paintSource(x, y, m.r);
        }
        break;
      case "step":
        this.stepOnce(e);
        break;
      case "probe":
        this.probeX = m.x;
        this.probeY = m.y;
        break;
    }
    // 在跑：改动跟着下一帧一起发（一帧就是一批步数，不额外插帧）。暂停：有空缓冲就马上发一帧
    this.dirty = true;
    if (!this.running) this.publish();
  }

  private stepOnce(e: ActiveEngine): void {
    if (this.pool) this.pool.step();
    else e.step();
  }

  /** 排一次 tick（让出来先处理消息）；已经排了就不再排 */
  private kick(): void {
    if (this.ticking) return;
    this.ticking = true;
    this.schedule(() => {
      this.ticking = false;
      this.tick();
    }, 0);
  }

  /**
   * 算一帧：要有一份空缓冲才算（两份都在主线程手里 = 模拟领先了一帧，等 ack）。
   * 算完马上发，再排下一次（中间先处理消息）
   */
  private tick(): void {
    const e = this.engine;
    if (!this.running || !e) return;
    if (this.inFlight >= BUFFERS) return; // 等：ack 来了会再 kick
    // 一帧走 perFrame 步（速度滑杆定）。大网格一步很慢时帧数跟着掉 —— 想要画面顺就把速度调小
    let t0 = performance.now();
    for (let s = 0; s < this.perFrame; s++) {
      this.stepOnce(e);
      const t1 = performance.now();
      this.stepMs += 0.1 * (t1 - t0 - this.stepMs);
      t0 = t1;
    }
    this.dirty = true;
    this.publish();
    this.kick();
  }

  /** 把现在的状态拷进一份空缓冲发给主线程（没有空缓冲就等 ack，dirty 留着） */
  private publish(): void {
    const e = this.engine;
    if (!e || !this.dirty || this.inFlight >= BUFFERS) return;
    this.dirty = false;
    this.inFlight++;
    const W = e.w,
      H = e.h,
      n = W * H;
    // 复用主线程还回来的数组（换过网格、尺寸不对就新分配）
    const sp = this.spare.pop() ?? null;
    const fit = sp !== null && sp.mass.length === n;
    const mass = fit ? sp.mass : new Float32Array(n);
    const rho = fit ? sp.rho : new Float32Array(n);
    const kind = fit ? sp.kind : new Uint8Array(n);
    let blocks: Float32Array | null = null;
    if (this.blocks) blocks = fit && sp.blocks && sp.blocks.length === n * 4 ? sp.blocks : new Float32Array(n * 4);
    mass.set(e.mass);
    rho.set(e.renderDensity());
    kind.set(e.kind);
    if (blocks) blocks.set(e.renderBlocks()!);
    let floor = 0;
    for (let k = Math.max(0, H - 5) * W; k < W * H; k++) floor += mass[k];
    let total = 0;
    for (let k = 0; k < mass.length; k++) total += mass[k];
    const probe = this.probeX >= 0 ? e.probe(this.probeX, this.probeY) : null;
    const transfer: Transferable[] = [mass.buffer, rho.buffer, kind.buffer];
    if (blocks) transfer.push(blocks.buffer);
    this.post(
      { t: "frame", gen: this.gen, w: W, h: H, mass, rho, kind, blocks, steps: e.stepCount, totalMass: total, floor, probe, stepMs: this.stepMs,
        threads: this.pool ? this.pool.active : 1, why: this.why || (this.pool ? this.pool.why : "") },
      transfer,
    );
  }
}
