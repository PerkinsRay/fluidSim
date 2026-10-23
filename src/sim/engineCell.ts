/**
 * 格心动量引擎（Cell-centred Momentum）—— 与 engineSimple 并列的另一套输运内核。
 *
 * 【为什么要换】交错网格把动量存在**边**上，前提是"一格里的水是均匀的"。一旦格子内部
 * 有了形状（一部分是水、一部分是空），同一条边就同时面对两种介质：湿的那部分随液体
 * 运动，干的那部分根本没有物质。单个标量 P 无法表示这件事，于是所有由它派生的量都变得
 * 含义不明 —— `moved` 里的 dt·|P|/m 是"占谁的比例"？limitP 的上限该用整格质量还是迎风侧的
 * 湿区？交叉项的格心速度又是在对什么做平均？
 *
 * 这正是 PLIC 失败的原因：质量通量被切成了湿条带，动量通量却还按整格算，两者不再描述
 * 同一份物质，于是单格水团既排不出水也积累不起速度（自由落体 32 格 → 3 格）。
 *
 * 【这套方案】速度存在**格心**：ux[i]、uy[i] 是格 i 的速度。
 *   - 动量属于格子，也就无条件属于这格的物质，不管它有多少；
 *   - 边上的速度退化成**插值**（按质量加权，这是平均唯一正确的用途）；
 *   - 被搬运的速度取**源格**（这是迎风唯一正确的用途）；
 *   - 质量与动量用同一个 dm、同一个源格速度搬运 —— 从构造上就不可能不一致。
 *     以后若要加 PLIC，只需缩放 dm，动量会自动跟着缩放。
 *
 * 规则（与 engineSimple 对齐，便于对比）：
 *   1) 压力 p = c·(m − m₀)（m ≥ m₀）/ 双井内聚（m < m₀），见 C_SCALE、COH_SCALE；
 *   2) 力只改动量：格 i 受到的压力合力 = 左右面压力之差（面压力由两侧格心插值），
 *      重力直接是加速度：uy += g·dt，不含质量；
 *   3) 质量按边速度迁移，动量随这份质量一起走（源格速度）；
 *   4) 粘性在格心之间按速度差交换动量 —— 格心形式下这一项变得非常直接。
 */
import { FluidEngine, CELL_WALL, CELL_SOURCE } from './engine';

/** 压力系数标定：c = expansion × C_SCALE（与 engineSimple 一致） */
const C_SCALE = 100;

/** 内聚双井强度：coh = (thinPush | tension) × COH_SCALE */
const COH_SCALE = 20;

/** 内聚只作用在两侧都有水（> WET）的面上：水与水之间的内力，成对出现、互相抵消 */
const WET = 0.05;

/**
 * 最大搬运速度（格/单位时间）。格心形式下可以直接按**合速度** |v| 限制，
 * 不再有"分量各限导致斜向可达 √2 倍"的各向异性问题（交错网格里这需要额外一遍扫描）。
 */
const MAX_SPEED = 12;

/** 单边每步最多搬走源格质量的这个比例（四条边合计 ≤ 1，保证质量非负） */
const MAX_FRAC = 0.25;

/** 粘性标定：k = VISC_SCALE · viscosity · dt，每步最多抹掉 VISC_K_MAX 的速度差 */
const VISC_SCALE = 12;
const VISC_K_MAX = 0.2;

export class FluidEngineCell extends FluidEngine {
  /** 时间步长（整体快慢；自由落体位移 ∝ (步数·dt)²） */
  timeStep = 0.01;
  /** 每个 step 内部细分的子步数（总物理时间仍是 timeStep） */
  substeps = 1;

  /**
   * 格心**速度** ux、uy（不是动量）。
   * 直接存速度的好处：重力项就是 uy += g·dt，完全不含质量；限幅直接作用在 |u| 上。
   * 代价是质量迁移时必须按动量加权混合（见第 4 步）—— 新来的物质带着自己的速度，
   * 接收格的速度要按 (m·u + Σ move·u_src) / (m + Σ move) 更新，否则会凭空造出动量。
   */
  readonly ux: Float32Array;
  readonly uy: Float32Array;

  /** 每格压力（状态方程）与内聚压力（双井，只用于两侧都湿的面） */
  private pBuf: Float32Array;
  private qBuf: Float32Array;
  /** 增量缓冲：一步内先全部算完再统一应用，与扫描顺序无关 */
  private dm: Float32Array;
  /** 动量增量（迁移阶段用；最后与质量增量一起换算回速度） */
  private dpx: Float32Array;
  private dpy: Float32Array;

  constructor(w: number, h: number) {
    super(w, h);
    const n = w * h;
    this.ux = new Float32Array(n);
    this.uy = new Float32Array(n);
    this.pBuf = new Float32Array(n);
    this.qBuf = new Float32Array(n);
    this.dm = new Float32Array(n);
    this.dpx = new Float32Array(n);
    this.dpy = new Float32Array(n);
  }

  override clear(): void {
    super.clear();
    this.ux.fill(0);
    this.uy.fill(0);
  }

  override step(): void {
    const n = Math.max(1, Math.floor(this.substeps));
    for (let s = 0; s < n; s++) this.advanceSub(this.timeStep / n);
    this.stepCount++;
  }

  private advanceSub(timeStep: number): void {
    const { w, h, mass, kind, ux, uy } = this;
    const { gravity, expansion, restDensity, viscosity } = this.params;
    const c = Math.max(expansion, 0) * C_SCALE;
    const g = Math.max(gravity, 0);
    const m0 = Math.max(restDensity, 0);
    const cohPush = m0 > 0 ? Math.max(this.params.thinPush ?? 0, 0) * COH_SCALE : 0;
    const cohPull = m0 > 0 ? Math.max(this.params.tension ?? 0, 0) * COH_SCALE : 0;
    const ampPush = cohPush * m0;
    const ampPull = cohPull * m0;
    // 声速 CFL：dt ≤ 0.5/√(2S + g)
    const stiff = Math.max(c, cohPush, cohPull);
    const dt = Math.min(timeStep, 0.5 / Math.sqrt(2 * stiff + g + 1e-6));

    const p = this.pBuf;
    const q = this.qBuf;
    const n = w * h;

    // ---- 1) 压力（只读质量，与扫描顺序无关）----
    q.fill(0);
    for (let i = 0; i < n; i++) {
      if (kind[i] === CELL_WALL) {
        p[i] = 0;
        continue;
      }
      const m = mass[i];
      if (m0 <= 0) {
        p[i] = c * m;
      } else if (m >= m0) {
        p[i] = c * (m - m0);
      } else {
        p[i] = 0;
        const u = m / m0;
        q[i] = (u < 0.5 ? ampPush : ampPull) * u * (1 - u) * (1 - 2 * u);
      }
    }

    // ---- 水源注入 ----
    for (let i = 0; i < n; i++) {
      if (kind[i] === CELL_SOURCE) mass[i] += this.sourceRate * dt;
    }

    // ---- 2) 力 → 速度 ----
    // 格心速度需要的是格心处的压力**梯度**，所以面压力取两侧格心的插值、再做差：
    //   fL − fR = 0.5·(p[i−1] + p[i]) − 0.5·(p[i] + p[i+1]) = 0.5·(p[i−1] − p[i+1])
    // 本格的 p[i] 被约掉是**正确**的，不是冗余：对称的压力峰对自己没有净力，
    // 它推开的是邻居。曾试过改成逐面 (p[i] − p[j])/m_平均 再分摊给两侧 —— 那是交错
    // 网格里"面上物质"的加速度，用在格心速度上会让孤立高压格凭空侧向加速
    // （手算 ux = 2a > 0，实测对称性从 2.6e-4 崩到 1.0）。
    //
    // 除以的是**本格质量**：这是对这一格物质的 F = ma，没有第二个格子可供平均。
    // 重力是加速度，不含质量 —— 自由落体因此与密度无关。
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const i = row + x;
        if (kind[i] === CELL_WALL) continue;
        const m = mass[i];
        if (m <= 1e-9) {
          ux[i] = 0;
          uy[i] = 0;
          continue;
        }
        const pi = p[i];
        const face = (j: number, inb: boolean): number => {
          if (!inb || kind[j] === CELL_WALL) return pi; // 墙 / 越界：面压力 = 本格（无净力）
          let f = 0.5 * (pi + p[j]);
          // 内聚只在两侧都湿的面上计入（水对水的内力，整团水合力为 0）
          if (m > WET && mass[j] > WET) f += 0.5 * (q[i] + q[j]);
          return f;
        };
        const fL = face(i - 1, x > 0);
        const fR = face(i + 1, x < w - 1);
        const fU = face(i - w, y > 0);
        const fD = face(i + w, y < h - 1);
        ux[i] += ((fL - fR) / m) * dt;
        uy[i] += ((fU - fD) / m + g) * dt;

        // 合速度限幅（各向同性，直接作用在速度上）
        const sp2 = ux[i] * ux[i] + uy[i] * uy[i];
        if (sp2 > MAX_SPEED * MAX_SPEED) {
          const k = MAX_SPEED / Math.sqrt(sp2);
          ux[i] *= k;
          uy[i] *= k;
        }
      }
    }

    // ---- 3) 粘性：格心之间按速度差交换动量（总动量守恒）----
    const nu = Math.min(VISC_SCALE * Math.min(Math.max(viscosity, 0), 0.95) * dt, VISC_K_MAX);
    if (nu > 0) {
      const ax = this.dpx;
      const ay = this.dpy;
      ax.fill(0);
      ay.fill(0);
      for (let y = 0; y < h; y++) {
        const row = y * w;
        for (let x = 0; x < w; x++) {
          const i = row + x;
          if (kind[i] === CELL_WALL) continue;
          const mi = mass[i];
          if (mi <= 1e-9) continue;
          const pair = (j: number): void => {
            if (kind[j] === CELL_WALL) return;
            const mj = mass[j];
            if (mj <= 1e-9) return;
            // 交换的是动量 J = k·min(m)·Δu，存速度时各自除以自身质量
            const mc = nu * Math.min(mi, mj);
            const jx = mc * (ux[i] - ux[j]);
            const jy = mc * (uy[i] - uy[j]);
            ax[i] -= jx / mi;
            ax[j] += jx / mj;
            ay[i] -= jy / mi;
            ay[j] += jy / mj;
          };
          if (x < w - 1) pair(i + 1);
          if (y < h - 1) pair(i + w);
        }
      }
      for (let i = 0; i < n; i++) {
        ux[i] += ax[i];
        uy[i] += ay[i];
      }
    }

    // ---- 4) 迁移：质量与动量用同一个 dm、同一个源格速度 ----
    // 这是这套方案的核心：两者不可能不一致。边速度按**质量加权**插值（平均的正确用途），
    // 被搬运的速度取**源格**（迎风的正确用途）。
    const dm = this.dm;
    const dpx = this.dpx;
    const dpy = this.dpy;
    dm.fill(0);
    dpx.fill(0);
    dpy.fill(0);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const i = row + x;
        if (kind[i] === CELL_WALL) continue;
        const flux = (j: number, horiz: boolean): void => {
          if (kind[j] === CELL_WALL) return;
          const mi = mass[i];
          const mj = mass[j];
          const mt = mi + mj;
          if (mt <= 1e-9) return;
          // 边速度：按质量加权平均（一侧为空时自然退化成另一侧的速度）。
          // 平均用在"插值出一点上的速度"，这是平均唯一正确的用途。
          const vEdge = horiz
            ? (mi * ux[i] + mj * ux[j]) / mt
            : (mi * uy[i] + mj * uy[j]) / mt;
          if (vEdge === 0) return;
          const src = vEdge > 0 ? i : j;
          const ms = mass[src];
          if (ms <= 1e-9) return;
          // MUSCL 斜率限制：在源格内重建线性分布、取**面上**的值，而不是直接用格心均值。
          // 一阶迎风每步按格心均值搬走 dt·v 的份额，界面因此被持续抹开 —— 实测纯平流里
          // 界面格随步数线性增长（50步 144 → 300步 416），自由下落的水团就此拖出长尾。
          const stride = horiz ? 1 : w;
          const sx = src % w;
          const upIdx = vEdge > 0 ? src - stride : src + stride;
          const upIn = horiz
            ? vEdge > 0
              ? sx > 0
              : sx < w - 1
            : vEdge > 0
              ? src >= w
              : src < n - w;
          const mUp = upIn && kind[upIdx] !== CELL_WALL ? mass[upIdx] : ms;
          // 两个梯度都沿流动方向度量
          const dDn = vEdge > 0 ? mj - mi : mi - mj;
          const dUp = ms - mUp;
          // minmod：同号取较小者，异号（极值点）取 0 —— 保单调，不产生新极值
          const slope = dDn * dUp > 0 ? (Math.abs(dDn) < Math.abs(dUp) ? dDn : dUp) : 0;
          const cfl = Math.abs(vEdge) * dt;
          const mFace = Math.max(0, ms + 0.5 * (1 - cfl) * slope);
          let move = dt * vEdge * mFace;
          // 钳制：单边不超过源格质量的 MAX_FRAC（四边合计 ≤ 1 ⇒ 质量非负）
          const cap = MAX_FRAC * ms;
          if (move > cap) move = cap;
          else if (move < -cap) move = -cap;
          // 这份质量带着源格的速度一起走。比例用 move/ms（源格质量），
          // 而不是 move/mFace —— 动量与质量必须以**同一份物质**为基准，否则两者会各自漂移，
          // 这正是 PLIC 失败的原因（质量按湿条带缩放、动量仍按整格，单格水团因此既排不出水
          // 也积累不起速度）。mFace 只影响搬多少，不影响这份质量携带的速度。
          const tx = move * ux[src];
          const ty = move * uy[src];
          dm[i] -= move;
          dm[j] += move;
          dpx[i] -= tx;
          dpx[j] += tx;
          dpy[i] -= ty;
          dpy[j] += ty;
        };
        if (x < w - 1) flux(i + 1, true);
        if (y < h - 1) flux(i + w, false);
      }
    }
    for (let i = 0; i < n; i++) {
      const d = dm[i];
      if (d === 0 && dpx[i] === 0 && dpy[i] === 0) continue;
      const mOld = mass[i];
      const mNew = mOld + d;
      if (mNew <= 1e-9) {
        mass[i] = mNew < 0 ? 0 : mNew;
        ux[i] = 0;
        uy[i] = 0;
        continue;
      }
      // 动量守恒地混合：新速度 = (原动量 + 流入动量) / 新质量。
      // 存速度时这一步不能省 —— 直接保留原速度就等于凭空造出动量。
      ux[i] = (mOld * ux[i] + dpx[i]) / mNew;
      uy[i] = (mOld * uy[i] + dpy[i]) / mNew;
      mass[i] = mNew;
    }
  }
}
