/**
 * 试验引擎（Simplified Fluid Engine）——**二阶（动量）**：
 * 质量决定压力 → 叠加一个重力场 → 力产生加速度 → 速度迁移质量。
 *
 * 规则：
 *   1) 每格由自身质量算出压力 p = c · m · react（c = expansion × 10，滑杆 0~2 → c 0~20；
 *      react 为静止密度门控，m ≥ m₀ 施压 100%，m 从 m₀ 降到 0.5·m₀ 线性衰减到 0），四方向相同；
 *   2) **重力场**是个**加速度** g，只作用在水平面（上下相邻格之间的那个面）上：
 *      a_竖直 = (p_上 − p_下)/m_边 + g。竖直面（左右相邻格之间的那个面）不加重力
 *      ——重力是 y 方向的体力，只体现在上下那个面上；
 *   3) **力只产生加速度，不产生速度**：a = F / m_边，m_边 = 两侧质量的平均（正在被推动的那份
 *      质量）。流速是加速度对时间的积分、跨步保留——这就是二阶：压差一反向，流速不会立刻
 *      跟着反向；
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
  /** 质量增量缓冲：这一步的流量先全部算完再一次性应用（与扫描顺序无关） */
  private deltaBuf: Float32Array;

  constructor(w: number, h: number) {
    super(w, h);
    this.pressureBuf = new Float32Array(w * h);
    this.fhBuf = new Float32Array(w * h);
    this.fvBuf = new Float32Array(w * h);
    this.deltaBuf = new Float32Array(w * h);
  }

  override clear(): void {
    super.clear();
    this.fhBuf.fill(0);
    this.fvBuf.fill(0);
  }

  override step(): void {
    const { w, h, mass, wall, source } = this;
    const { gravity, expansion, restDensity, viscosity } = this.params;
    // 压力系数：滑杆 0.1（app 默认）→ c=1。表面边上的压力是重力的 2c/g 倍——c=20 时是 40 倍，
    // 水团会被四面吹散；c≈1 才和重力量级相当。
    const c = Math.max(expansion, 0) * 10;
    const g = Math.max(gravity, 0);
    // 静止密度的过渡带：从 0.5·m₀ 线性升到 m₀（低于 0.5·m₀ 完全不施压）
    const restHalf = 0.5 * restDensity;
    const restInv = restHalf > 0 ? 1 / restHalf : 0;
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
      const react = restDensity > 0 ? Math.min(1, Math.max(0, (m - restHalf) * restInv)) : 1;
      p[i] = c * m * react;
    }
    // ---- 水源注入：按 dt 计，否则每帧上百步会把格子灌爆 ----
    for (let i = 0; i < source.length; i++) {
      if (source[i] && !wall[i]) mass[i] += this.sourceRate * dt;
    }
    // ---- 2) 力 → 加速度 → 速度（跨步保留）----
    const fh = this.fhBuf;
    const fv = this.fvBuf;
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const i = row + x;
        if (wall[i]) {
          fh[i] = 0;
          fv[i] = 0;
          continue;
        }
        const mi = mass[i];
        if (x < w - 1 && !wall[i + 1]) {
          const mj = mass[i + 1];
          const me = Math.max(0.5 * (mi + mj), 1e-3); // 被推动的质量
          fh[i] = this.limitVel((fh[i] + ((p[i] - p[i + 1]) / me) * dt) * damp, mi, mj, me, dt);
        } else {
          fh[i] = 0;
        }
        if (y < h - 1 && !wall[i + w]) {
          const mj = mass[i + w];
          const me = Math.max(0.5 * (mi + mj), 1e-3);
          // 重力场就体现在水平面上：它直接是加速度 g，跟被推的那份质量无关
          const a = (p[i] - p[i + w]) / me + g;
          fv[i] = this.limitVel((fv[i] + a * dt) * damp, mi, mj, me, dt);
        } else {
          fv[i] = 0;
        }
      }
    }
    // ---- 3) 质量按流速迁移：这一步搬走 dt·m_边·v，先全部算完再一次性应用 ----
    const delta = this.deltaBuf;
    delta.fill(0);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const i = row + x;
        if (wall[i]) continue;
        const mi = mass[i];
        const a = fh[i];
        if (a !== 0) {
          const q = dt * Math.max(0.5 * (mi + mass[i + 1]), 1e-3) * a;
          delta[i] -= q;
          delta[i + 1] += q;
        }
        const b = fv[i];
        if (b !== 0) {
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

  /** 速度钳制：dt·m_边·|v| ≤ 源格质量/4（源格由流向决定），保证质量恒非负 */
  private limitVel(v: number, mi: number, mj: number, me: number, dt: number): number {
    const lim = 0.25 / (dt * me);
    if (v > 0) return Math.min(v, mi * lim);
    if (v < 0) return -Math.min(-v, mj * lim);
    return 0;
  }
}
