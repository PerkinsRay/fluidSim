/**
 * 试验引擎（Simplified Fluid Engine）——**二阶（动量）**：
 * 质量决定压力 → 叠加一个重力场 → 力产生加速度 → 速度迁移质量。
 *
 * 规则：
 *   1) 每格由自身质量算出压力 p = c · max(0, m − m₀)（c = expansion × 10，滑杆 0~2 → c 0~20；
 *      m₀ = restDensity）——**压力相对静止密度**：比 m₀ 密才往外推，稀于 m₀ 不拉（负压下限）。
 *      这是"弹性系数很高"的正确写法：没有参考点的 c·m 里"刚度"没有意义，c 一大表面就被吹爆；
 *   2) **重力场**是个**加速度** g，只作用在水平面（上下相邻格之间的那个面）上：
 *      a_竖直 = (p_上 − p_下)/m_边 + g。竖直面（左右相邻格之间的那个面）不加重力
 *      ——重力是 y 方向的体力，只体现在上下那个面上；
 *   3) **力只产生加速度，不产生速度**：a = F / m_边，m_边 = 两侧质量的平均（正在被推动的那份
 *      质量）。流速是加速度对时间的积分、跨步保留——这就是二阶：压差一反向，流速不会立刻
 *      跟着反向。加速度里还有一项**平流**（速度跟着质量走，控制体是这条面自己，见 advect）；
 *   4) 质量由**速度**迁移：这一步跨过这条边的质量 = dt · m_边 · v（连续性方程。少了 dt·m_边
 *      这个因子就从双曲型退化成扩散型，色散变成 ω ∝ 1/√dt，CFL 又回到 1/c）。
 *
 * 【为什么二阶值得再试一次】一阶（流速瞬时等于驱动力）是扩散型：稳定界 dt ≲ 1/c，而且**均匀的
 *   重力场散度为 0**——水团在空气里根本不掉（每格给出的和收到的一样多，净变化为 0）。二阶是
 *   双曲型，稳定界 dt ≲ 1/√(2c)，力可以累积成速度。之前二阶失败是因为 c=200（滑杆 0.1 × 200），
 *   表面边上的压力是重力的 2c/g = 40 倍，水团被四面吹散；现在 c 的系数改成 ×10（默认 c=1），
 *   那个比值只有 2 倍。
 *
 * 两个标定旋钮：`timeStep`（整体快慢；自由落体位移 ∝ (步数·dt)²，所以它比 CFL 允许的小得多）
 * 与 `viscosity`（速度阻尼）。
 */
import { FluidEngine } from './engine';

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

/**
 * 撞墙反弹系数：贴墙那条边本来是每步清零（墙把往下冲的动量整个吃掉）。
 * 但那条边自己**从没被施加过加速度**（走的是跳过分支），所以它的速度恒为 0——
 * 单纯把它反号是白改。正确做法是**镜像**：贴墙那条边取**上游那条边**的速度反号，
 * 相当于墙外有个镜像的水体在往上冲。平流会读邻边速度，于是这个反向速度被一格一步
 * 搬进水里，就是"撞上墙立刻给一个极大的反向加速度"。
 * 1 = 完全弹性（水像皮球一样弹回）；0.5 = 弹一半；0 = 原来的行为。
 * 注意真实的水砸地面不会弹性弹回、而是往两边摊开，所以这是理想化的；先用 1 看效果再往回收。
 */
const WALL_BOUNCE = 1;

export class FluidEngineSimple extends FluidEngine {
  /**
   * 时间步长：决定整体快慢。自由落体里位移 ∝ (步数·dt)²，所以取值远小于 CFL 允许的
   * 0.5/√(2c+g)（默认参数下约 0.29），否则一步就飞过整个画布。
   */
  timeStep = 0.01;
  /** 每格压力缓存（由自身质量决定） */
  private pressureBuf: Float32Array;
  /** 每条边的流速（跨步保留的状态量，即"正在流动的那份质量"的动量）：fh[i] 右边 i→i+1，fv[i] 下边 */
  private fhBuf: Float32Array;
  private fvBuf: Float32Array;
  /**
   * 下一帧速度缓冲。平流项要看**整幅旧速度场**（上下游邻边）：边扫边改的话，
   * 先处理过的邻居已经是新值，扫描顺序会给两种奇偶的格子不同待遇 → 种出棋盘花纹。
   */
  private fhNext: Float32Array;
  private fvNext: Float32Array;
  /** 质量增量缓冲：这一步的流量先全部算完再一次性应用（与扫描顺序无关） */
  private deltaBuf: Float32Array;

  constructor(w: number, h: number) {
    super(w, h);
    this.pressureBuf = new Float32Array(w * h);
    this.fhBuf = new Float32Array(w * h);
    this.fvBuf = new Float32Array(w * h);
    this.fhNext = new Float32Array(w * h);
    this.fvNext = new Float32Array(w * h);
    this.deltaBuf = new Float32Array(w * h);
  }

  override clear(): void {
    super.clear();
    this.fhBuf.fill(0);
    this.fvBuf.fill(0);
    this.fhNext.fill(0);
    this.fvNext.fill(0);
  }

  override step(): void {
    const { w, h, mass, wall, source } = this;
    const { gravity, expansion, restDensity, viscosity } = this.params;
    // 压力系数：滑杆 0.1（app 默认）→ c=1。表面边上的压力是重力的 2c/g 倍——c=20 时是 40 倍，
    // 水团会被四面吹散；c≈1 才和重力量级相当。
    const c = Math.max(expansion, 0) * 10;
    const g = Math.max(gravity, 0);
    // 静止密度的过渡带：从 0.5·m₀ 线性升到 m₀（低于 0.5·m₀ 完全不施压）
    const m0 = Math.max(restDensity, 0);
    // 声速 CFL：dt ≤ 0.5/√(2c+g)；正常情况由 timeStep 兜住（它小得多）
    const dt = Math.min(this.timeStep, 0.5 / Math.sqrt(2 * c + g + 1e-6));
    // 粘稠度 = 速度阻尼（每单位时间衰减的比例）
    const damp = Math.max(0, 1 - Math.min(Math.max(viscosity, 0), 0.95) * dt);

    // ---- 1) 每格压力：只由自身质量决定（含静止密度门控）----
    const p = this.pressureBuf;
    for (let i = 0; i < p.length; i++) {
      const m = mass[i];
      if (wall[i]) {
        p[i] = 0;
        continue;
      }
      // 压力**相对静止密度**：比 m₀ 密才施压，稀于 m₀ 不拉（负压下限 = 空化）。
      // "弹性系数很高"的含义就在这里——稍微偏离 m₀ 就产生大压力把它按回去，
      // 密度因此没有自由起伏的空间（真实的水密度几乎是常数）。
      // m₀ = 0 时退化成 p = c·m。
      p[i] = c * Math.max(0, m - m0);
    }
    // ---- 水源注入：按 dt 计，否则每帧上百步会把格子灌爆 ----
    for (let i = 0; i < source.length; i++) {
      if (source[i] && !wall[i]) mass[i] += this.sourceRate * dt;
    }
    // ---- 2) 力 → 加速度 → 速度（跨步保留）----
    const fh = this.fhBuf;
    const fv = this.fvBuf;
    const fhNext = this.fhNext;
    const fvNext = this.fvNext;
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const i = row + x;
        if (wall[i]) {
          fhNext[i] = 0;
          fvNext[i] = 0;
          continue;
        }
        const mi = mass[i];
        if (x < w - 1 && !wall[i + 1]) {
          const mj = mass[i + 1];
          const me = Math.max(0.5 * (mi + mj), 1e-3); // 被推动的质量（惯性）
          // 平流的控制体是这条面自己的：左格心 ↔ 右格心。边界上的量由相邻两面插值，
          // 不能直接拿"西邻面/本面"当边界（那等于把控制体西移半格 → 奇偶错位）。
          const vW = x > 0 ? fh[i - 1] : 0;
          const mW = x > 0 ? 0.5 * (mass[i - 1] + mi) : me;
          const vE = x < w - 2 ? fh[i + 1] : 0;
          const mE = x < w - 2 ? 0.5 * (mass[i + 1] + mass[i + 2]) : me;
          const v0 = this.advect(fh[i], vW, mW, vE, mE, me, dt);
          const a = (p[i] - p[i + 1]) / me;
          fhNext[i] = this.limitVel((v0 + a * dt) * damp, mi, mj, me, dt);
        } else {
          fhNext[i] = -WALL_BOUNCE * (x > 0 ? fh[i - 1] : 0); // 墙：镜像上游那条边，弹回去
        }
        if (y < h - 1 && !wall[i + w]) {
          const mj = mass[i + w];
          const me = Math.max(0.5 * (mi + mj), 1e-3);
          const vW = y > 0 ? fv[i - w] : 0;
          const mW = y > 0 ? 0.5 * (mass[i - w] + mi) : me;
          const vE = y < h - 2 ? fv[i + w] : 0;
          const mE = y < h - 2 ? 0.5 * (mass[i + w] + mass[i + 2 * w]) : me;
          // 重力场就体现在水平面上：它直接是加速度 g，跟被推的那份质量无关
          const v0 = this.advect(fv[i], vW, mW, vE, mE, me, dt);
          const a = (p[i] - p[i + w]) / me + g;
          fvNext[i] = this.limitVel((v0 + a * dt) * damp, mi, mj, me, dt);
        } else {
          fvNext[i] = -WALL_BOUNCE * (y > 0 ? fv[i - w] : 0); // 墙：镜像上游那条边，弹回去
        }
      }
    }
    fh.set(fhNext);
    fv.set(fvNext);
    // ---- 3) 质量按流速迁移：这一步搬走 dt·m_边·v，先全部算完再一次性应用 ----
    const delta = this.deltaBuf;
    delta.fill(0);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const i = row + x;
        if (wall[i]) continue;
        const mi = mass[i];
        // 贴墙 / 越界的那条边不搬质量（它的速度只用来做镜像，见碰撞反弹）
        const a = fh[i];
        if (a !== 0 && x < w - 1 && !wall[i + 1]) {
          const q = dt * Math.max(0.5 * (mi + mass[i + 1]), 1e-3) * a;
          delta[i] -= q;
          delta[i + 1] += q;
        }
        const b = fv[i];
        if (b !== 0 && y < h - 1 && !wall[i + w]) {
          const q = dt * Math.max(0.5 * (mi + mass[i + w]), 1e-3) * b;
          delta[i] -= q;
          delta[i + w] += q;
        }
      }
    }
    for (let i = 0; i < mass.length; i++) {
      const d = delta[i];
      if (d !== 0) mass[i] += d;
    }
    this.stepCount++;
  }

  /** 鼠标指到哪一格就读哪一格（调试用；墙 / 越界返回 null） */
  probe(x: number, y: number): CellProbe | null {
    const { w, h, wall, mass } = this;
    if (x < 0 || y < 0 || x >= w || y >= h) return null;
    if (wall[y * w + x]) return null;
    const p = this.pressureBuf;
    const fh = this.fhBuf;
    const fv = this.fvBuf;
    const i = y * w + x;
    const solid = (j: number) => j < 0 || j >= w * h || wall[j] === 1;
    const right = x < w - 1 && !solid(i + 1) ? { dp: p[i] - p[i + 1], v: fh[i] } : { dp: 0, v: 0 };
    const left = x > 0 && !solid(i - 1) ? { dp: p[i] - p[i - 1], v: -fh[i - 1] } : { dp: 0, v: 0 };
    const down = y < h - 1 && !solid(i + w) ? { dp: p[i] - p[i + w], v: fv[i] } : { dp: 0, v: 0 };
    const up = y > 0 && !solid(i - w) ? { dp: p[i] - p[i - w], v: -fv[i - w] } : { dp: 0, v: 0 };
    return { x, y, mass: mass[i], pressure: p[i], right, left, down, up };
  }

  /**
   * 平流：**速度跟着质量走**。控制体是**这条面自己的**——从左侧格心到右侧格心（面在正中）。
   *
   * 两条边界在**格心**上，那里的通量与速度由相邻的两个面各取一半插值出来；每条边界再按
   * 通量方向取上游那一侧的速度（迎风）。写成这样左右是**显式对称**的：每条边界只看它两侧的
   * 两个面，跟"我自己动不动"无关。
   *
   * 之前那版把"西邻面、本面"直接当控制体的两条边界——等于把控制体整整西移了半格。交错网格上
   * 半格错位会造出奇偶错位，实测整场挪一格、水恒向右漂（镜像测试：A 的剖面 = B 的剖面错开一格）。
   */
  private advect(
    v: number,
    vW: number,
    mW: number,
    vE: number,
    mE: number,
    mSelf: number,
    dt: number,
  ): number {
    const qW = 0.5 * dt * (mW * vW + mSelf * v); // 西边界（左格心）的质量通量，正 = 向东
    const qE = 0.5 * dt * (mSelf * v + mE * vE); // 东边界（右格心）的质量通量，正 = 向东
    const uW = qW > 0 ? vW : v; // 迎风：往东流就带西侧的速度
    const uE = qE > 0 ? v : vE;
    const mNew = mSelf + qW - qE;
    if (mNew <= 1e-6) return v;
    return (mSelf * v + qW * uW - qE * uE) / mNew;
  }

  /** 速度钳制：dt·m_边·|v| ≤ 源格质量/4（源格由流向决定），保证质量恒非负 */
  private limitVel(v: number, mi: number, mj: number, me: number, dt: number): number {
    const lim = 0.25 / (dt * me);
    if (v > 0) return Math.min(v, mi * lim);
    if (v < 0) return -Math.min(-v, mj * lim);
    return 0;
  }
}
