/**
 * 平均质量引擎（Edge Velocity + Average Mass）—— 第三套输运内核，用于对照试验。
 *
 * 【设计】速度存在**边**上（边速度不可或缺：格心单个矢量无法表示膨胀 —— 对称膨胀的
 * 平均速度为零，实测孤立高压格永远卡在 m=30 不动，见 engineCell 的局限），
 * 但**边质量统一取两侧格的平均** m_e = (m_i + m_j)/2，并贯穿加速度、平流、质量通量。
 *
 * 与 engineSimple 的区别：
 *   - engineSimple 存的是**动量** P = m·v，搬运时按**源格**质量定比例（迎风）；
 *   - 本引擎存的是**速度** u，加速度 a = Δp/m_e，质量通量 dm = dt·u·m_e（平均质量）。
 *
 * 存速度 + 平均质量带来的简化：
 *   - 重力就是 a = g，不含质量；
 *   - 平流退化成速度的平流（du/dt = −u·∂u/∂x − v·∂u/∂y），不需要"按谁的质量定比例"，
 *     交叉项是 MAC 标准插值（四条横向边取平均），不再有"挑哪条 fv"的歧义；
 *   - 不需要 fhNext/fvNext 之外的额外缓冲。
 *
 * 已知代价（平均质量的固有性质，不是实现缺陷）：
 *   - 自由表面处加速度被放大：水格紧邻空格时 m_e = m/2，同样的压差给出两倍加速度；
 *   - 速度平流是非守恒形式（MAC / Stable Fluids 的标准做法），动量不严格守恒。
 *   - **唯一的例外**：质量通量的钳制必须按**源格**质量，否则质量会变负
 *     （薄格紧邻满格时 m_e 远大于薄格自身质量，一步就能把它抽成负数 —— 实测
 *     在 engineSimple 上把 limitP 改成平均质量会炸到 −2.9e+28）。
 */
import { FluidEngine, CELL_WALL, CELL_SOURCE } from './engine';
import type { CellProbe } from './engineSimple';

/** 压力系数标定：c = expansion × C_SCALE（与其他引擎一致，便于对比） */
const C_SCALE = 100;

/** 内聚双井强度：coh = (thinPush | tension) × COH_SCALE */
const COH_SCALE = 20;

/** 内聚只作用在两侧都有水（> WET）的面上：水对水的内力，整团水合力为 0 */
const WET = 0.05;

/** 最大速度（格/单位时间） */
const MAX_SPEED = 12;

/** 单边每步最多搬走源格质量的这个比例（四边合计 ≤ 1 ⇒ 质量非负） */
const MAX_FRAC = 0.25;

/** 粘性标定：k = VISC_SCALE · viscosity · dt，每步最多抹掉 VISC_K_MAX 的速度差 */
const VISC_SCALE = 12;
const VISC_K_MAX = 0.2;

/** 边上有物质的下限：低于它认为这条边没有水，速度归零 */
const EDGE_EPS = 1e-9;

export class FluidEngineAvg extends FluidEngine {
  /** 时间步长（整体快慢；自由落体位移 ∝ (步数·dt)²） */
  timeStep = 0.01;
  /** 每个 step 内部细分的子步数（总物理时间仍是 timeStep） */
  substeps = 1;

  /** 边**速度**（不是动量）：uh[i] 是边 i→i+1 的 u，uv[i] 是边 i→i+w 的 v */
  readonly uh: Float32Array;
  readonly uv: Float32Array;

  /** 下一步速度缓冲：平流要读整幅旧速度场，原地改会让结果依赖扫描顺序 */
  private uhNext: Float32Array;
  private uvNext: Float32Array;
  /** 每格压力（状态方程）与内聚压力（双井） */
  private pBuf: Float32Array;
  private qBuf: Float32Array;
  /** 质量增量：一步内先算完再统一应用 */
  private dmBuf: Float32Array;

  constructor(w: number, h: number) {
    super(w, h);
    const n = w * h;
    this.uh = new Float32Array(n);
    this.uv = new Float32Array(n);
    this.uhNext = new Float32Array(n);
    this.uvNext = new Float32Array(n);
    this.pBuf = new Float32Array(n);
    this.qBuf = new Float32Array(n);
    this.dmBuf = new Float32Array(n);
  }

  override clear(): void {
    super.clear();
    this.uh.fill(0);
    this.uv.fill(0);
    this.uhNext.fill(0);
    this.uvNext.fill(0);
  }

  override step(): void {
    const n = Math.max(1, Math.floor(this.substeps));
    for (let s = 0; s < n; s++) this.advanceSub(this.timeStep / n);
    this.stepCount++;
  }

  private advanceSub(timeStep: number): void {
    const { w, h, mass, kind, uh, uv } = this;
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
    const uhN = this.uhNext;
    const uvN = this.uvNext;
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

    // ---- 2) 边速度：平流 + 加速度 ----
    // 平流是**速度**的平流（非守恒形式）：du/dt = −u·∂u/∂x − v·∂u/∂y，用一阶迎风。
    // 横向速度由 MAC 标准插值给出（四条垂直边取平均）—— 存速度后交叉项就是这个插值，
    // 不再有 engineSimple 里"该挑哪条 fv、用谁的质量"的歧义。
    // 加速度 a = Δp/m_e + g，m_e 为两侧格质量的平均（本引擎的核心假设）。
    uhN.set(uh);
    uvN.set(uv);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const i = row + x;
        if (kind[i] === CELL_WALL) continue;

        // --- 水平边 i → i+1 ---
        if (x < w - 1 && kind[i + 1] !== CELL_WALL) {
          const me = 0.5 * (mass[i] + mass[i + 1]);
          if (me <= EDGE_EPS) {
            uhN[i] = 0;
          } else {
            const u0 = uh[i];
            // 本方向迎风差分：u > 0 用 (u − u_左)，u < 0 用 (u_右 − u)。
            // 两个分支的**差分方向**必须随速度符号翻转 —— 都写成 (u − u_邻) 会让
            // 平流项在镜像下变成 adv' = +adv（应为 −adv），对称性因此崩掉（实测 3.9e-1）。
            const uL = x > 0 ? uh[i - 1] : 0;
            const uR = x < w - 2 ? uh[i + 1] : 0;
            const dudx = u0 > 0 ? u0 - uL : uR - u0;
            // 横向速度：这条水平边位于 (x+0.5, y)，取它周围四条垂直边的平均
            const vA = y > 0 ? uv[i - w] : 0;
            const vB = y < h - 1 ? uv[i] : 0;
            const vC = x < w - 1 && y > 0 ? uv[i + 1 - w] : 0;
            const vD = x < w - 1 && y < h - 1 ? uv[i + 1] : 0;
            const vAt = 0.25 * (vA + vB + vC + vD);
            // 横向迎风差分：同样按 v 的符号选方向
            const uUp = y > 0 ? uh[i - w] : 0;
            const uDn = y < h - 1 ? uh[i + w] : 0;
            const dudy = vAt > 0 ? u0 - uUp : uDn - u0;
            const adv = -u0 * dudx - vAt * dudy;
            let F = p[i] - p[i + 1];
            if (mass[i] > WET && mass[i + 1] > WET) F += q[i] - q[i + 1];
            let un = u0 + (adv + F / me) * dt;
            if (un > MAX_SPEED) un = MAX_SPEED;
            else if (un < -MAX_SPEED) un = -MAX_SPEED;
            uhN[i] = un;
          }
        } else {
          uhN[i] = 0; // 墙 / 越界：不可穿透
        }

        // --- 垂直边 i → i+w ---
        if (y < h - 1 && kind[i + w] !== CELL_WALL) {
          const me = 0.5 * (mass[i] + mass[i + w]);
          if (me <= EDGE_EPS) {
            uvN[i] = 0;
          } else {
            const v0 = uv[i];
            const vU = y > 0 ? uv[i - w] : 0;
            const vD = y < h - 2 ? uv[i + w] : 0;
            const dvdy = v0 > 0 ? v0 - vU : vD - v0;
            // 这条垂直边位于 (x, y+0.5)，取它周围四条水平边的平均
            const uA = x > 0 ? uh[i - 1] : 0;
            const uB = x < w - 1 ? uh[i] : 0;
            const uC = x > 0 && y < h - 1 ? uh[i + w - 1] : 0;
            const uD = x < w - 1 && y < h - 1 ? uh[i + w] : 0;
            const uAt = 0.25 * (uA + uB + uC + uD);
            const vL = x > 0 ? uv[i - 1] : 0;
            const vR = x < w - 1 ? uv[i + 1] : 0;
            const dvdx = uAt > 0 ? v0 - vL : vR - v0;
            const adv = -v0 * dvdy - uAt * dvdx;
            let F = p[i] - p[i + w];
            if (mass[i] > WET && mass[i + w] > WET) F += q[i] - q[i + w];
            // 重力是加速度，不含质量 —— 自由落体因此与密度无关
            let vn = v0 + (adv + F / me + g) * dt;
            if (vn > MAX_SPEED) vn = MAX_SPEED;
            else if (vn < -MAX_SPEED) vn = -MAX_SPEED;
            uvN[i] = vn;
          }
        } else {
          uvN[i] = 0;
        }
      }
    }
    uh.set(uhN);
    uv.set(uvN);

    // ---- 3) 粘性：相邻平行边按速度差交换（存速度时直接对速度做）----
    const nu = Math.min(VISC_SCALE * Math.min(Math.max(viscosity, 0), 0.95) * dt, VISC_K_MAX);
    if (nu > 0) {
      uhN.set(uh);
      uvN.set(uv);
      for (let y = 0; y < h; y++) {
        const row = y * w;
        for (let x = 0; x < w; x++) {
          const i = row + x;
          if (kind[i] === CELL_WALL) continue;
          // 水平边：与下一行、右一条交换
          if (x < w - 1 && kind[i + 1] !== CELL_WALL) {
            if (y < h - 1 && kind[i + w] !== CELL_WALL && kind[i + w + 1] !== CELL_WALL) {
              const d = nu * (uh[i] - uh[i + w]);
              uhN[i] -= d;
              uhN[i + w] += d;
            }
            if (x < w - 2 && kind[i + 2] !== CELL_WALL) {
              const d = nu * (uh[i] - uh[i + 1]);
              uhN[i] -= d;
              uhN[i + 1] += d;
            }
          }
          // 垂直边：与右一列、下一条交换
          if (y < h - 1 && kind[i + w] !== CELL_WALL) {
            if (x < w - 1 && kind[i + 1] !== CELL_WALL && kind[i + 1 + w] !== CELL_WALL) {
              const d = nu * (uv[i] - uv[i + 1]);
              uvN[i] -= d;
              uvN[i + 1] += d;
            }
            if (y < h - 2 && kind[i + 2 * w] !== CELL_WALL) {
              const d = nu * (uv[i] - uv[i + w]);
              uvN[i] -= d;
              uvN[i + w] += d;
            }
          }
        }
      }
      uh.set(uhN);
      uv.set(uvN);
    }

    // ---- 4) 质量通量：dm = dt · u · m_源（源格质量）----
    // 平均质量只用在**加速度**（F/m_e）和平流插值上；真正搬走的物质必须按**源格**算：
    //   - 用 m_e 会让自由落体变慢：单格水下方那条边 m_e = m/2，每步只搬一半的质量
    //     （实测落体 12.5 → 9.8 格，还会随密度微变 9.8/9.7/9.6）；
    //   - 而且 m_e 可能远大于源格自身质量（薄格紧邻满格），会把薄格抽成负数。
    const dm = this.dmBuf;
    dm.fill(0);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const i = row + x;
        if (kind[i] === CELL_WALL) continue;
        const flux = (j: number, vel: number): void => {
          if (vel === 0) return;
          const src = vel > 0 ? i : j;
          const ms = mass[src];
          if (ms <= EDGE_EPS) return;
          let move = dt * vel * ms;
          const cap = MAX_FRAC * ms;
          if (move > cap) move = cap;
          else if (move < -cap) move = -cap;
          dm[i] -= move;
          dm[j] += move;
        };
        if (x < w - 1 && kind[i + 1] !== CELL_WALL) flux(i + 1, uh[i]);
        if (y < h - 1 && kind[i + w] !== CELL_WALL) flux(i + w, uv[i]);
      }
    }
    for (let i = 0; i < n; i++) {
      const d = dm[i];
      if (d !== 0) {
        const mNew = mass[i] + d;
        mass[i] = mNew < 0 ? 0 : mNew;
      }
    }
  }
  /**
   * 调试读数：悬停时显示一格的质量、压力，以及四条边的压差与流速。
   * 本引擎边上直接存速度，所以不需要像 engineSimple 那样把动量换算回速度。
   */
  probe(x: number, y: number): CellProbe | null {
    const { w, h, kind, mass, uh, uv } = this;
    if (x < 0 || y < 0 || x >= w || y >= h) return null;
    const i = y * w + x;
    if (kind[i] === CELL_WALL) return null;
    const p = this.pBuf;
    const solid = (j: number) => j < 0 || j >= w * h || kind[j] === CELL_WALL;
    const right =
      x < w - 1 && !solid(i + 1) ? { dp: p[i] - p[i + 1], v: uh[i] } : { dp: 0, v: 0 };
    const left =
      x > 0 && !solid(i - 1) ? { dp: p[i] - p[i - 1], v: -uh[i - 1] } : { dp: 0, v: 0 };
    const down =
      y < h - 1 && !solid(i + w) ? { dp: p[i] - p[i + w], v: uv[i] } : { dp: 0, v: 0 };
    const up =
      y > 0 && !solid(i - w) ? { dp: p[i] - p[i - w], v: -uv[i - w] } : { dp: 0, v: 0 };
    return { x, y, mass: mass[i], pressure: p[i], right, left, down, up };
  }

}
