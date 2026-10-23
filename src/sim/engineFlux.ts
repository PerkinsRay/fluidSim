/**
 * 散射版引擎（Scatter Momentum Flux）—— 平流改成"每条边只管自己往外推"。
 *
 * 大循环里每条边只处理**自己的流出**，四个方向各一支：
 *   沿流向：u > 0 → 交给右边那条平行边，数量 = m(右侧格)·dt·u·u
 *           u < 0 → 交给左边那条平行边，数量 = m(左侧格)·dt·|u|·u
 *   交叉向：下面那个面平均速度向下 → 交给下面那条平行边，数量 = m(自身速度源格)·dt·|V下|·u
 *           上面那个面平均速度向上 → 交给上面那条平行边，数量 = m(自身速度源格)·dt·|V上|·u
 * 统一成一句：**流出量 = m_源 · dt · |V_该方向| · v_自身**，自己减多少、邻边就加多少。
 *
 * 为什么这样写比"收集流入"好：
 * 每一笔都是成对的（自己 −T、邻边 +T），总动量**结构性**守恒，不依赖任何边界补丁。
 * 之前的收集式（engineMix）把流出无条件扣掉、流入却被 `x > 0` 之类的越界判断挡住，
 * 于是边界附近扣掉的那份动量没有边接手、凭空消失 —— 实测"流出/流入"比 0.954 且随步数
 * 继续漂（0.9537 → 0.9570）；内区留白 8 格后比值精确回到 1.0000，说明漏的全在边界。
 * 散射式下这个比值恒等于 1：没有"接收边不存在"的情况，因为不存在的邻边根本不会被推。
 *
 * 另外，只推不收也就不需要判断"谁是上游"：方向由各自的速度符号决定，
 * 四种符号组合自然互补，不会重复也不会遗漏。
 */
import { FluidEngine, CELL_WALL, CELL_SOURCE } from "./engine";

/** 调试读数：一格的质量、压力，以及四条边的压力差与流速（正 = 由本格流出） */
export interface CellProbe {
  x: number;
  y: number;
  mass: number;
  pressure: number;
  right: { dp: number; v: number };
  left: { dp: number; v: number };
  down: { dp: number; v: number };
  up: { dp: number; v: number };
}

/** 压力系数标定：c = expansion × C_SCALE（64 格深的水压缩 < 10% 需要 c ≈ 200） */
const C_SCALE = 100;

/** 墙的冲击压力系数：贴墙格额外压力 = IMPACT·wallBounce·m·v²（完全反射对应 2） */
const IMPACT = 2;

/** 内聚双井强度：A = (thinPush | tension) × COH_SCALE × m₀ */
const COH_SCALE = 20;

/**
 * 最大速度（格/单位时间）。按**合速度**限制，不能对 uh、uv 各自限 ——
 * 分量各限会让斜向合速度达到 MAX_SPEED·√2，结构上允许对角比轴向快 41%。
 */
const MAX_SPEED = 12;

/** 交叉项系数（竖直流动搬运水平动量，以及它的镜像）。1 = 完整二维平流 */
const CROSS: number = 1;

/** 剪切粘性标定：k = VISC_SCALE · viscosity · dt */
const VISC_SCALE = 12;
const VISC_K_MAX = 0.2;

/** 内聚只作用在两侧质量都 > WET 的边上（水 ↔ 水的内力，整团水合力为 0） */
const WET = 0.05;

/** 单向每步最多搬走的比例（四个方向合计 ≤ 1 ⇒ 动量不会被推成反号） */
const MAX_FRAC = 0.25;

/** 水源溢出的补水范围（格）：按欧氏距离由近到远排序 */
const SOURCE_RADIUS = 4;
const SOURCE_RING: [number, number][] = (() => {
  const r = SOURCE_RADIUS;
  const out: [number, number][] = [];
  for (let dy = -r; dy <= r; dy++)
    for (let dx = -r; dx <= r; dx++)
      if (dx * dx + dy * dy <= r * r) out.push([dx, dy]);
  return out.sort(
    (a, b) => a[0] * a[0] + a[1] * a[1] - (b[0] * b[0] + b[1] * b[1]),
  );
})();

export class FluidEngineFlux extends FluidEngine {
  /** 时间步长（整体快慢；自由落体位移 ∝ (步数·dt)²） */
  timeStep = 0.01;
  /** 每个 step 内部细分的子步数（总物理时间仍是 timeStep） */
  substeps = 1;

  /** 每条边的速度（跨步保留的状态量）：uh[i] 右边 i→i+1，uv[i] 下边 i→i+w */
  readonly uh: Float32Array;
  readonly uv: Float32Array;

  /** 每格压力 / 内聚压力 */
  private pressureBuf: Float32Array;
  private cohBuf: Float32Array;
  /** 子步内的动量工作区（由速度 × 当前边质量重建，末尾按**更新后**的边质量换回速度） */
  private phBuf: Float32Array;
  private pvBuf: Float32Array;
  /** 动量增量：散射的每一笔都先记在这里，全部算完再统一应用（与扫描顺序无关） */
  private dphBuf: Float32Array;
  private dpvBuf: Float32Array;
  /** 质量增量缓冲 */
  private deltaBuf: Float32Array;
  /** 各向同性限速的缩放系数（先算完再应用） */
  private capH: Float32Array;
  private capV: Float32Array;

  constructor(w: number, h: number) {
    super(w, h);
    const n = w * h;
    this.uh = new Float32Array(n);
    this.uv = new Float32Array(n);
    this.pressureBuf = new Float32Array(n);
    this.cohBuf = new Float32Array(n);
    this.phBuf = new Float32Array(n);
    this.pvBuf = new Float32Array(n);
    this.dphBuf = new Float32Array(n);
    this.dpvBuf = new Float32Array(n);
    this.deltaBuf = new Float32Array(n);
    this.capH = new Float32Array(n);
    this.capV = new Float32Array(n);
  }

  override clear(): void {
    super.clear();
    this.uh.fill(0);
    this.uv.fill(0);
  }

  override step(): void {
    const n = Math.max(1, Math.floor(this.substeps));
    for (let s = 0; s < n; s++) this.advanceSub(this.timeStep / n);
    this.stepCount++;
  }

  /** 推进一个子步（物理时间 = timeStep / substeps，CFL 照样再兜一层） */
  private advanceSub(timeStep: number): void {
    const { w, h, mass, kind, uh, uv } = this;
    const { gravity, expansion, restDensity, viscosity } = this.params;
    const c = Math.max(expansion, 0) * C_SCALE;
    const g = Math.max(gravity, 0);
    const m0 = Math.max(restDensity, 0);
    const cohPush =
      m0 > 0 ? Math.max(this.params.thinPush ?? 0, 0) * COH_SCALE : 0;
    const cohPull =
      m0 > 0 ? Math.max(this.params.tension ?? 0, 0) * COH_SCALE : 0;
    const ampPush = cohPush * m0;
    const ampPull = cohPull * m0;
    const stiff = Math.max(c, cohPush, cohPull);
    const dt = Math.min(timeStep, 0.5 / Math.sqrt(2 * stiff + g + 1e-6));
    const n = w * h;
    const vCap = Math.min(MAX_SPEED, MAX_FRAC / dt);

    /** 这条水平边是否存在且开通（两侧都不是墙） */
    const openH = (e: number): boolean =>
      e >= 0 && e < n && e % w < w - 1 && kind[e] !== CELL_WALL && kind[e + 1] !== CELL_WALL;
    /** 这条竖直边是否存在且开通 */
    const openV = (e: number): boolean =>
      e >= 0 && e + w < n && kind[e] !== CELL_WALL && kind[e + w] !== CELL_WALL;

    // ---- 1) 每格压力 p（状态方程）+ 内聚压力 q（双井，只读质量）----
    const p = this.pressureBuf;
    const q = this.cohBuf;
    q.fill(0);
    const impact = IMPACT * Math.max(this.params.wallBounce ?? 0, 0);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const i = row + x;
        if (kind[i] === CELL_WALL) {
          p[i] = 0;
          continue;
        }
        const m = mass[i];
        let pi: number;
        if (m0 <= 0) {
          pi = c * m;
        } else if (m >= m0) {
          pi = c * (m - m0);
        } else {
          pi = 0;
          const u = m / m0;
          q[i] = (u < 0.5 ? ampPush : ampPull) * u * (1 - u) * (1 - 2 * u);
        }
        if (impact > 0) {
          let v2 = 0;
          if ((x === w - 1 || kind[i + 1] === CELL_WALL) && x > 0) {
            const v = uh[i - 1];
            if (v > 0) v2 += v * v;
          }
          if (x === 0 || kind[i - 1] === CELL_WALL) {
            const v = x < w - 1 ? uh[i] : 0;
            if (v < 0) v2 += v * v;
          }
          if ((y === h - 1 || kind[i + w] === CELL_WALL) && y > 0) {
            const v = uv[i - w];
            if (v > 0) v2 += v * v;
          }
          if (y === 0 || kind[i - w] === CELL_WALL) {
            const v = y < h - 1 ? uv[i] : 0;
            if (v < 0) v2 += v * v;
          }
          pi += impact * m * v2;
        }
        p[i] = pi;
      }
    }

    // ---- 水源注入：先灌满水源格，溢出按欧氏距离由近到远补进周围没满的格 ----
    for (let i = 0; i < n; i++) {
      if (kind[i] !== CELL_SOURCE) continue;
      let add = this.sourceRate * dt;
      if (m0 <= 0) {
        mass[i] += add;
        continue;
      }
      const sx = i % w;
      const sy = (i - sx) / w;
      for (let k = 0; k < SOURCE_RING.length && add > 1e-9; k++) {
        const [dx, dy] = SOURCE_RING[k];
        const x = sx + dx;
        const y = sy + dy;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const j = y * w + x;
        if (kind[j] === CELL_WALL || mass[j] >= m0) continue;
        const put = Math.min(add, m0 - mass[j]);
        mass[j] += put;
        add -= put;
      }
      if (add > 0) mass[i] += add;
    }

    // ---- 2) 速度 → 动量（用当前边质量；边质量 = 两侧格质量的平均，这是
    //         交错网格上动量控制体的质量，"在一点上取值"用平均是对的）----
    const ph = this.phBuf;
    const pv = this.pvBuf;
    const meH = (e: number): number => 0.5 * (mass[e] + mass[e + 1]);
    const meV = (e: number): number => 0.5 * (mass[e] + mass[e + w]);
    for (let i = 0; i < n; i++) {
      ph[i] = openH(i) ? uh[i] * meH(i) : 0;
      pv[i] = openV(i) ? uv[i] * meV(i) : 0;
    }

    // ---- 3) 散射平流：每条边只往外推，四个方向各一支 ----
    // 流出量 T = m_源 · dt · |V_方向| · v_自身，自己 −T、目标边 +T。
    // 成对出现 ⇒ 总动量结构性守恒；不存在的邻边不会被推，所以也没有"动量凭空消失"。
    const dph = this.dphBuf;
    const dpv = this.dpvBuf;
    dph.fill(0);
    dpv.fill(0);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const i = row + x;

        // ========== 水平边 i → i+1，自身动量 ph[i]、自身速度 uh[i] ==========
        if (openH(i)) {
          const u = uh[i];
          if (u !== 0) {
            // 单向流出上限：不超过本边动量控制体质量的 MAX_FRAC
            // （四个方向合计 ≤ 1，动量不会被推成反号）
            const cap = MAX_FRAC * meH(i);
            const push = (dst: number, dm: number): void => {
              if (dm <= 0) return;
              const T = (dm > cap ? cap : dm) * u;
              dph[i] -= T;
              dph[dst] += T;
            };
            // 沿流向：向右给 i+1（过的是右侧格 i+1 的物质），向左给 i−1
            if (u > 0) {
              if (openH(i + 1)) push(i + 1, mass[i + 1] * dt * u);
            } else if (openH(i - 1) && x > 0) {
              push(i - 1, mass[i] * dt * -u);
            }
            // 交叉向：自身动量被竖直流动搬走。源格取**自身速度的迎风格**，
            // 面速度取该面两条竖直边的平均（对 x 镜像不变 ⇒ 左右对称是结构性的）
            if (CROSS !== 0) {
              const ms = mass[u > 0 ? i : i + 1];
              if (ms > 1e-9) {
                // 下面那个面向下 ⇒ 交给下面那条水平边
                if (y < h - 1) {
                  const vB = 0.5 * (uv[i] + uv[i + 1]);
                  if (vB > 0 && openH(i + w)) push(i + w, ms * dt * vB * CROSS);
                }
                // 上面那个面向上 ⇒ 交给上面那条水平边
                if (y > 0) {
                  const vT = 0.5 * (uv[i - w] + uv[i + 1 - w]);
                  if (vT < 0 && openH(i - w)) push(i - w, ms * dt * -vT * CROSS);
                }
              }
            }
          }
        }

        // ========== 竖直边 i → i+w（水平的镜像）==========
        if (openV(i)) {
          const v = uv[i];
          if (v !== 0) {
            const cap = MAX_FRAC * meV(i);
            const push = (dst: number, dm: number): void => {
              if (dm <= 0) return;
              const T = (dm > cap ? cap : dm) * v;
              dpv[i] -= T;
              dpv[dst] += T;
            };
            if (v > 0) {
              if (openV(i + w)) push(i + w, mass[i + w] * dt * v);
            } else if (openV(i - w) && y > 0) {
              push(i - w, mass[i] * dt * -v);
            }
            if (CROSS !== 0) {
              const ms = mass[v > 0 ? i : i + w];
              if (ms > 1e-9) {
                if (x < w - 1) {
                  const uR = 0.5 * (uh[i] + uh[i + w]);
                  if (uR > 0 && openV(i + 1)) push(i + 1, ms * dt * uR * CROSS);
                }
                if (x > 0) {
                  const uL = 0.5 * (uh[i - 1] + uh[i + w - 1]);
                  if (uL < 0 && openV(i - 1)) push(i - 1, ms * dt * -uL * CROSS);
                }
              }
            }
          }
        }
      }
    }
    for (let i = 0; i < n; i++) {
      ph[i] += dph[i];
      pv[i] += dpv[i];
    }

    // ---- 4) 力：压差是冲量 dP = F·dt（与质量无关），源格必须有水 ----
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const i = row + x;
        const mi = mass[i];
        if (openH(i)) {
          const mj = mass[i + 1];
          const coh = mi > WET && mj > WET ? q[i] - q[i + 1] : 0;
          const F = p[i] - p[i + 1] + coh;
          // F > 0 把 i 推向 j（源格 i）；F < 0 把 j 拉回 i（源格 j）。
          // 拉一个空格时拉不出水，水也就不会被粘在空气上。
          if (F > 0 ? mi > 1e-9 : F < 0 ? mj > 1e-9 : false) ph[i] += F * dt;
        }
        if (openV(i)) {
          const mj = mass[i + w];
          const coh = mi > WET && mj > WET ? q[i] - q[i + w] : 0;
          const F = p[i] - p[i + w] + coh;
          if (F > 0 ? mi > 1e-9 : F < 0 ? mj > 1e-9 : false) pv[i] += F * dt;
        }
      }
    }

    // ---- 5) 剪切粘性：相邻平行边之间按速度差交换动量（总动量守恒）----
    this.applyViscosity(viscosity, dt);

    // ---- 6) 动量 → 速度（这里还是**旧**边质量：质量尚未迁移），再加重力与限速 ----
    // 重力按 engineSimple 的写法：**动量冲量** dP = g·m_i·dt（m_i = 上方那格的质量）。
    //
    // 这里曾经写成"加速度" dv = g·dt（不含质量，水团整体平移、不被拉长）。两种写法
    // 在溃坝 / 静水这类有自由表面的场景里差别很大：加速度形式会给几乎空的边也加满重力，
    // 表面格的静水平衡因此变松，实测 dam 闪烁 0.327，而冲量形式 0.129
    // （engineSimple 是 0.091）。其余指标不受影响：剪切漂移仍是 1.2e-3（优于 Simple 的
    // 2.9e-3）、镜像仍是 3.1e-3（优于 4.0e-2），落体仍与密度无关。
    //
    // 代价：水团的尾迹更长（跨 92 行 vs Simple 的 56 行，浓核 3 行 vs 10 行）——
    // 那是散射平流的一阶迎风扩散，与重力这一项无关。
    for (let i = 0; i < n; i++) {
      const a = openH(i) ? meH(i) : 0;
      uh[i] = a > 1e-9 ? ph[i] / a : 0;
      const b = openV(i) ? meV(i) : 0;
      uv[i] = b > 1e-9 ? (pv[i] + g * mass[i] * dt) / b : 0;
    }
    // 各向同性限速：按合速度缩放（先全部算完再统一应用，避免依赖扫描顺序）
    {
      const sh = this.capH;
      const sv = this.capV;
      sh.fill(1);
      sv.fill(1);
      for (let y = 0; y < h; y++) {
        const row = y * w;
        for (let x = 0; x < w; x++) {
          const i = row + x;
          if (openH(i)) {
            const vA = y > 0 ? 0.5 * (uv[i - w] + uv[i]) : uv[i];
            const vB = y > 0 ? 0.5 * (uv[i + 1 - w] + uv[i + 1]) : uv[i + 1];
            const sp = Math.hypot(uh[i], 0.5 * (vA + vB));
            if (sp > vCap) sh[i] = vCap / sp;
          }
          if (openV(i)) {
            const uA = x > 0 ? 0.5 * (uh[i - 1] + uh[i]) : uh[i];
            const uB = x > 0 ? 0.5 * (uh[i + w - 1] + uh[i + w]) : uh[i + w];
            const sp = Math.hypot(0.5 * (uA + uB), uv[i]);
            if (sp > vCap) sv[i] = vCap / sp;
          }
        }
      }
      for (let i = 0; i < n; i++) {
        if (sh[i] !== 1) uh[i] *= sh[i];
        if (sv[i] !== 1) uv[i] *= sv[i];
      }
    }

    // ---- 7) 质量迁移：dm = v · m_面 · dt（m_面 = 源格内 MUSCL 重建的面值，见下）----
    // 迁移前先把动量锁定成 u·m_旧，迁移后再除以 m_新 —— 否则质量变化处速度会被放大
    // （水团上沿流走后 m_e 变小，u = P/m_e 被抬高，实测自由落体超速 65%）。
    for (let i = 0; i < n; i++) {
      ph[i] = openH(i) ? uh[i] * meH(i) : 0;
      pv[i] = openV(i) ? uv[i] * meV(i) : 0;
    }
    const delta = this.deltaBuf;
    delta.fill(0);
    // MUSCL 面值重建（superbee 限制器）：一阶迎风每步按**格心均值**搬走 dt·v 那一份，
    // 界面因此被持续抹开 —— 一格水自由下落 600 步后铺满 27 格（90% 质量在 17 格里），
    // 这就是"下落的水被拉成一条长线"。改成在源格里按限制后的斜率线性重建，取这一步
    // 扫过的那一段的平均质量：前沿那格斜率向下 ⇒ 面上质量更少 ⇒ 搬得更慢，界面保持陡峭。
    //   实测（600 步）：跨 27 → 15 格，90% 质量 17 → 10 格；dam 闪烁 0.129 → 0.047。
    // superbee 是 TVD 限制器里最"压缩"的一个（minmod / van Leer 依次更温和：
    // 90% 宽 12 / 11 格），用来专门对付拉长正合适。
    // 只改**质量**通量，动量散射保持原样：试过让动量也用同一个重建通量，
    // 闪烁反而涨到 0.7 —— 质量锐化后近乎空的边上 m_e 很小，动量一除就变成大速度。
    const lim = (a: number, b: number): number => {
      if (a * b <= 0) return 0; // 极值点：不重建，保单调
      const s = a > 0 ? 1 : -1;
      const A = Math.abs(a);
      const B = Math.abs(b);
      return s * Math.max(Math.min(2 * A, B), Math.min(A, 2 * B));
    };
    /** 源格 src 朝 dn 那一侧的面上、这一步扫过那段的平均质量（up = 源格的上游邻格） */
    const faceMass = (src: number, up: number, dn: number, upOk: boolean, cfl: number): number => {
      const ms = mass[src];
      const mu = upOk ? mass[up] : ms; // 上游是墙 / 越界：按本格算（单侧差分）
      const mf = ms + 0.5 * (1 - cfl) * lim(ms - mu, mass[dn] - ms);
      return mf > 0 ? mf : 0;
    };
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const i = row + x;
        const a = uh[i];
        if (a !== 0 && openH(i)) {
          const ms = mass[a > 0 ? i : i + 1];
          if (ms > 1e-9) {
            const cfl = Math.min(1, Math.abs(a) * dt);
            const mf =
              a > 0
                ? faceMass(i, i - 1, i + 1, x > 0 && kind[i - 1] !== CELL_WALL, cfl)
                : faceMass(i + 1, i + 2, i, x < w - 2 && kind[i + 2] !== CELL_WALL, cfl);
            let dm = dt * a * mf;
            const cap = MAX_FRAC * ms;
            if (dm > cap) dm = cap;
            else if (dm < -cap) dm = -cap;
            delta[i] -= dm;
            delta[i + 1] += dm;
          }
        }
        const b = uv[i];
        if (b !== 0 && openV(i)) {
          const ms = mass[b > 0 ? i : i + w];
          if (ms > 1e-9) {
            const cfl = Math.min(1, Math.abs(b) * dt);
            const mf =
              b > 0
                ? faceMass(i, i - w, i + w, y > 0 && kind[i - w] !== CELL_WALL, cfl)
                : faceMass(i + w, i + 2 * w, i, y < h - 2 && kind[i + 2 * w] !== CELL_WALL, cfl);
            let dm = dt * b * mf;
            const cap = MAX_FRAC * ms;
            if (dm > cap) dm = cap;
            else if (dm < -cap) dm = -cap;
            delta[i] -= dm;
            delta[i + w] += dm;
          }
        }
      }
    }
    for (let i = 0; i < n; i++) {
      const d = delta[i];
      if (d !== 0) mass[i] += d;
    }

    // ---- 8) 动量 → 速度：必须用**更新后**的边质量 ----
    for (let i = 0; i < n; i++) {
      const a = openH(i) ? meH(i) : 0;
      uh[i] = a > 1e-9 ? ph[i] / a : 0;
      const b = openV(i) ? meV(i) : 0;
      uv[i] = b > 1e-9 ? pv[i] / b : 0;
    }
  }

  /** 鼠标指到哪一格就读哪一格（调试用；墙 / 越界返回 null） */
  probe(x: number, y: number): CellProbe | null {
    const { w, h, kind, mass, uh, uv } = this;
    if (x < 0 || y < 0 || x >= w || y >= h) return null;
    if (kind[y * w + x] === CELL_WALL) return null;
    const p = this.pressureBuf;
    const i = y * w + x;
    const solid = (j: number) => j < 0 || j >= w * h || kind[j] === CELL_WALL;
    const right =
      x < w - 1 && !solid(i + 1)
        ? { dp: p[i] - p[i + 1], v: uh[i] }
        : { dp: 0, v: 0 };
    const left =
      x > 0 && !solid(i - 1)
        ? { dp: p[i] - p[i - 1], v: -uh[i - 1] }
        : { dp: 0, v: 0 };
    const down =
      y < h - 1 && !solid(i + w)
        ? { dp: p[i] - p[i + w], v: uv[i] }
        : { dp: 0, v: 0 };
    const up =
      y > 0 && !solid(i - w)
        ? { dp: p[i] - p[i - w], v: -uv[i - w] }
        : { dp: 0, v: 0 };
    return { x, y, mass: mass[i], pressure: p[i], right, left, down, up };
  }

  /**
   * 剪切粘性：每一对相邻的平行边按速度差交换动量
   *   J = k · m_共 · (v_a − v_b)，k = VISC_SCALE · viscosity · dt，m_共 = 两边质量的较小者。
   * 一边减多少另一边就加多少 ⇒ 总动量守恒，整体平动（自由落体）不受影响。
   * 墙当作"速度 0、质量无穷大"的水：贴墙的平行邻边吸收 kw·P（kw = k·(1 − 反弹)）。
   */
  private applyViscosity(viscosity: number, dt: number): void {
    const { w, h, mass, kind } = this;
    const k = Math.min(
      VISC_SCALE * Math.min(Math.max(viscosity, 0), 0.95) * dt,
      VISC_K_MAX,
    );
    if (k <= 0) return;
    const ph = this.phBuf;
    const pv = this.pvBuf;
    const nh = this.dphBuf;
    const nv = this.dpvBuf;
    nh.set(ph);
    nv.set(pv);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const j = row + x;
        if (kind[j] === CELL_WALL) continue;
        if (x < w - 1 && kind[j + 1] !== CELL_WALL) {
          const ma = 0.5 * (mass[j] + mass[j + 1]);
          if (ma > 1e-6) {
            const va = ph[j] / ma;
            if (
              y < h - 1 &&
              kind[j + w] !== CELL_WALL &&
              kind[j + w + 1] !== CELL_WALL
            ) {
              const mb = 0.5 * (mass[j + w] + mass[j + w + 1]);
              if (mb > 1e-6) {
                const J = k * (ma < mb ? ma : mb) * (va - ph[j + w] / mb);
                nh[j] -= J;
                nh[j + w] += J;
              }
            }
            if (x < w - 2 && kind[j + 2] !== CELL_WALL) {
              const mb = 0.5 * (mass[j + 1] + mass[j + 2]);
              if (mb > 1e-6) {
                const J = k * (ma < mb ? ma : mb) * (va - ph[j + 1] / mb);
                nh[j] -= J;
                nh[j + 1] += J;
              }
            }
          }
        }
        if (y < h - 1 && kind[j + w] !== CELL_WALL) {
          const ma = 0.5 * (mass[j] + mass[j + w]);
          if (ma > 1e-6) {
            const va = pv[j] / ma;
            if (
              x < w - 1 &&
              kind[j + 1] !== CELL_WALL &&
              kind[j + 1 + w] !== CELL_WALL
            ) {
              const mb = 0.5 * (mass[j + 1] + mass[j + 1 + w]);
              if (mb > 1e-6) {
                const J = k * (ma < mb ? ma : mb) * (va - pv[j + 1] / mb);
                nv[j] -= J;
                nv[j + 1] += J;
              }
            }
            if (y < h - 2 && kind[j + 2 * w] !== CELL_WALL) {
              const mb = 0.5 * (mass[j + w] + mass[j + 2 * w]);
              if (mb > 1e-6) {
                const J = k * (ma < mb ? ma : mb) * (va - pv[j + w] / mb);
                nv[j] -= J;
                nv[j + w] += J;
              }
            }
          }
        }
      }
    }
    const kw = k * (1 - Math.min(Math.max(this.params.wallBounce ?? 0, 0), 1));
    for (let y = 0; kw > 0 && y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const j = row + x;
        if (kind[j] === CELL_WALL) continue;
        if (x < w - 1 && kind[j + 1] !== CELL_WALL && ph[j] !== 0) {
          let cnt = 0;
          if (y === 0 || kind[j - w] === CELL_WALL || kind[j - w + 1] === CELL_WALL) cnt++;
          if (y === h - 1 || kind[j + w] === CELL_WALL || kind[j + w + 1] === CELL_WALL) cnt++;
          if (x === 0 || kind[j - 1] === CELL_WALL) cnt++;
          if (x + 2 >= w || kind[j + 2] === CELL_WALL) cnt++;
          if (cnt) nh[j] -= kw * cnt * ph[j];
        }
        if (y < h - 1 && kind[j + w] !== CELL_WALL && pv[j] !== 0) {
          let cnt = 0;
          if (x === 0 || kind[j - 1] === CELL_WALL || kind[j - 1 + w] === CELL_WALL) cnt++;
          if (x === w - 1 || kind[j + 1] === CELL_WALL || kind[j + 1 + w] === CELL_WALL) cnt++;
          if (y === 0 || kind[j - w] === CELL_WALL) cnt++;
          if (y + 2 >= h || kind[j + 2 * w] === CELL_WALL) cnt++;
          if (cnt) nv[j] -= kw * cnt * pv[j];
        }
      }
    }
    ph.set(nh);
    pv.set(nv);
  }
}
