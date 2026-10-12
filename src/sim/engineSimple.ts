/**
 * 试验引擎（Simplified Fluid Engine）——**二阶（动量）**：
 * 质量决定压力 → 叠加一个重力场 → 力产生加速度 → 速度迁移质量。
 *
 * 规则：
 *   1) 每格由自身质量算出压力（m₀ = restDensity，c = expansion × 100，滑杆 0~2 → c 0~200）：
 *      m ≥ m₀ 时 p = c·(m − m₀)（压缩段：比 m₀ 密才往外推）；m < m₀ 时是对称双井
 *      p = A·u(1−u)(1−2u)（内聚：稀薄的水往外推、近满的水往回拉，强度由 tension 决定，见 COH_SCALE）；
 *   2) **重力场**是个**加速度** g，只作用在水平面（上下相邻格之间的那个面）上：
 *      a_竖直 = (p_上 − p_下)/m_边 + g。竖直面（左右相邻格之间的那个面）不加重力
 *      ——重力是 y 方向的体力，只体现在上下那个面上；
 *   3) 每条边存**动量** P = m·v（跨步保留，二阶：压差一反向，流动不会立刻跟着反向）。
 *      力只改动量：dP = F·m_src/m_边·dt，m_src 是被力推走 / 拉走的那一侧的质量——拉一个空格
 *      时 m_src = 0，负压拉不出水；重力是体力，dP = g·m_上·dt。动量还会随水**平流**（二维：沿本方向
 *      见 advect，垂直方向的流动也带着动量走，见第 2 步）；
 *   4) 质量由动量迁移：这一步跨过这条边的质量 = dt · P（P 本身就是单位时间流过的质量。
 *      连续性方程，双曲型；只受"源格质量/4"限制，保证质量恒非负）。
 *
 * 【为什么二阶值得再试一次】一阶（流速瞬时等于驱动力）是扩散型：稳定界 dt ≲ 1/c，而且**均匀的
 *   重力场散度为 0**——水团在空气里根本不掉（每格给出的和收到的一样多，净变化为 0）。二阶是
 *   双曲型，稳定界 dt ≲ 1/√(2c)，力可以累积成速度。之前二阶在 c=200 时失败，是因为液体以
 *   2.5~3 倍静止密度填入，第 0 步就带着 ~2c 的压力，水团被四面吹散。按 m₀ 填入后表面压力 ≈ 0，
 *   c=200 就稳定了（见 C_SCALE）。
 *
 * 两个标定旋钮：`timeStep`（整体快慢；自由落体位移 ∝ (步数·dt)²，所以它比 CFL 允许的小得多）
 * 与 `viscosity`（剪切粘性：相邻平行边之间按速度差交换动量，见 applyViscosity）。
 */
import { FluidEngine, CELL_WALL, CELL_SOURCE } from './engine';

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
 * 压力系数 c 的标定：c = expansion × C_SCALE。
 * 静水平衡时每往下一格质量变为 (1 + g/2c)/(1 − g/2c) 倍，即可压缩尺度约 c/g 格：
 * c = 1 时每格 ×3（三格深底层就是顶层 27 倍），c ≥ g/2 时水柱直接塌进最底一行。
 * 水深 D 格时要压缩 ≲ 10%，需要 c ≳ 10·g·D——64 格网格里约 200。
 * 这么大的 c 不会把表面吹爆的前提是：液体以静止密度 m₀ 填入（见 presets / paintLiquid），
 * 静止时表面格 ≈ m₀，压力 ≈ 0。
 */
const C_SCALE = 100;

/**
 * 墙的冲击压力系数：贴墙格额外压力 = IMPACT·wallBounce·m·v²（v = 冲向墙的上游边速度）。
 * 完全反射时动量变化是 2mv，对应冲击压力 2ρv²，所以 wallBounce = 1 时取 2。
 */
const IMPACT = 2;

/**
 * 内聚（对称双井势，不加梯度项）：m < m₀ 时 p = A·u(1−u)(1−2u)，u = m/m₀，A = coh·m₀，
 * 两半分开调：u < 0.5（推力瓣）A = thinPush × COH_SCALE × m₀，u > 0.5（拉力瓣）A = tension × COH_SCALE × m₀
 * （滑杆 0~1 → 0~20）。u = 0.5 处两半压力都是 0，所以总是连续；系数不同时只在 0.5 处有个折角。
 * - u = 0（空气）与 u = 1（满格）两个井底压力都为 0，正负面积相等，液体停在 m₀、压力 0；
 * - 0 < u < 0.5 压力为正（稀薄的水往外推），0.5 < u < 1 压力为负（近满的水往回拉）；
 * - 0.21 < u < 0.79 斜率为负（反扩散）→ 均匀薄层会自己分成"满 + 空"。
 * m ≥ m₀ 时接线性压缩段 c·(m − m₀)。双井在 0 与 m₀ 处的斜率都是 coh。
 */
const COH_SCALE = 20;

/**
 * 水的最大搬运速度（格/单位时间）：|P| / m_源 的上限。
 * 64 格的画布自由落体到底约 √(2·g·64) ≈ 11，取 12 不影响正常的下落、溃坝与撞墙，
 * 只截掉近干薄水里的虚假高速（实测雨预设里横向 49 → 15，可见水 16 → 11）。
 */
const MAX_SPEED = 12;

/**
 * 二维平流里垂直方向那一项（交叉项）的系数。
 * 0 = 只沿本方向平流：动量只能沿轴走，爆开的水长成十字；
 * 1 = 完整交叉项：中心取平均的横向流把动量往两侧拖，爆开的水长成方形（角在对角线上）；
 * 1/√2：两种偏差大致抵消，最接近圆（实测单格爆开 100 步 A4 = 0.04，1 为 −0.59，0 为 0.89）。
 */
const CROSS = 1;

/**
 * 剪切粘性的标定：k = VISC_SCALE · viscosity · dt。滑杆 0.95 → 每秒约 11 份速度差被抹平；
 * 每步最多抹掉 VISC_K_MAX（< 0.25 保证四个邻边同时交换也不会让速度差反号）。
 */
const VISC_SCALE = 12;
const VISC_K_MAX = 0.2;

/**
 * 内聚只作用在两侧质量都 > WET 的边上（水 ↔ 水）。
 * 现实里内聚是水分子之间的内力：成对出现、大小相等方向相反，整团水的合力为 0，
 * 所以不会让下落的水变慢、也不会把水"粘"在空气上。水 ↔ 空气的边只有普通压力。
 */
const WET = 0.05;

/** 水源溢出的补水范围（格）：水源周围半径内的格按欧氏距离由近到远排序 */
const SOURCE_RADIUS = 4;
const SOURCE_RING: [number, number][] = (() => {
  const r = SOURCE_RADIUS;
  const out: [number, number][] = [];
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dy * dy <= r * r) out.push([dx, dy]);
  return out.sort((a, b) => a[0] * a[0] + a[1] * a[1] - (b[0] * b[0] + b[1] * b[1]));
})();

export class FluidEngineSimple extends FluidEngine {
  /**
   * 时间步长：决定整体快慢。自由落体里位移 ∝ (步数·dt)²，所以取值远小于 CFL 允许的
   * 0.5/√(2c+g)（默认参数下约 0.29），否则一步就飞过整个画布。
   */
  timeStep = 0.01;
  /**
   * 每个 step 内部再细分的子步数（总物理时间仍是 timeStep，整体快慢不变）。
   * 存动量后 1 就够（静止后闪烁 ≤ 0.007）；调大可以进一步压低振荡，计算量随之成倍增加。
   */
  substeps = 1;
  /** 每格压力缓存（由自身质量决定） */
  private pressureBuf: Float32Array;
  /** 每格内聚压力（双井部分）：只用于两侧都有水的边，不作用在水 / 空气界面上 */
  private cohBuf: Float32Array;
  /**
   * 每条边的动量 P = m·v（跨步保留的状态量；也就是单位时间流过这条边的质量）：
   * fh[i] 右边 i→i+1，fv[i] 下边 i→i+w。
   */
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
    this.cohBuf = new Float32Array(w * h);
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
    const n = Math.max(1, Math.floor(this.substeps));
    for (let s = 0; s < n; s++) this.advanceSub(this.timeStep / n);
    this.stepCount++;
  }

  /** 推进一个子步（物理时间 = timeStep / substeps，CFL 照样再兜一层） */
  private advanceSub(timeStep: number): void {
    const { w, h, mass, kind } = this;
    const { gravity, expansion, restDensity, viscosity } = this.params;
    // 压力系数（见 C_SCALE）：滑杆 2（默认）→ c = 200，64 格深的水压缩 < 10%。
    const c = Math.max(expansion, 0) * C_SCALE;
    const g = Math.max(gravity, 0);
    const m0 = Math.max(restDensity, 0);
    // 内聚强度（见 COH_SCALE）：只在有静止密度时才有意义（双井的两个井底是 0 与 m₀）
    // 两半分开调：u < 0.5 的推力瓣用 thinPush，u > 0.5 的拉力瓣用 tension
    const cohPush = m0 > 0 ? Math.max(this.params.thinPush ?? 0, 0) * COH_SCALE : 0;
    const cohPull = m0 > 0 ? Math.max(this.params.tension ?? 0, 0) * COH_SCALE : 0;
    const ampPush = cohPush * m0;
    const ampPull = cohPull * m0;
    // 声速 CFL：dt ≤ 0.5/√(2S + g)，S = 最硬段的斜率（双井在 u=0 处斜率 cohPush，u=1 处 cohPull）
    const stiff = Math.max(c, cohPush, cohPull);
    const dt = Math.min(timeStep, 0.5 / Math.sqrt(2 * stiff + g + 1e-6));

    // ---- 1) 每格压力 p（状态方程）+ 内聚压力 q（双井，只读质量，与扫描顺序无关）----
    const p = this.pressureBuf;
    const q = this.cohBuf;
    q.fill(0);
    const fhOld = this.fhBuf;
    const fvOld = this.fvBuf;
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
          pi = c * m; // 无静止密度：退化成 p = c·m
        } else if (m >= m0) {
          pi = c * (m - m0); // 压缩段：比 m₀ 密才往外推
        } else {
          const u = m / m0;
          // 双井：u < 0.5 稀相往外推（thinPush），u > 0.5 近满往回拉（tension）；u = 0.5 处两半都为 0，压力连续
          // 内聚（双井）单独存进 q：它是水与水之间的力，只在两侧都有水的边上起作用（见第 2 步）
          pi = 0;
          q[i] = (u < 0.5 ? ampPush : ampPull) * u * (1 - u) * (1 - 2 * u);
        }
        // 墙的反作用力（只给力，不改速度）：贴墙格的上游边正往墙里冲时，
        // 墙给这一格加一份冲击压力 IMPACT·wallBounce·m·v²（动量通量 = 冲击压力）。
        // 这份压力既让冲进来的水减速、也把它推向两侧；静止的水 v ≈ 0，不受影响。
        if (impact > 0) {
          let v2 = 0;
          // 边上存的是动量 P，速度 v = P / m_边（m_边 = 两侧平均质量）
          const vOf = (P: number, a: number, b: number) => { const me = 0.5 * (mass[a] + mass[b]); return me > 1e-6 ? P / me : 0; };
          if ((x === w - 1 || kind[i + 1] === CELL_WALL) && x > 0) { const v = vOf(fhOld[i - 1], i - 1, i); if (v > 0) v2 += v * v; } // 右侧是墙
          if (x === 0 || kind[i - 1] === CELL_WALL) { const v = x < w - 1 ? vOf(fhOld[i], i, i + 1) : 0; if (v < 0) v2 += v * v; } // 左侧是墙
          if ((y === h - 1 || kind[i + w] === CELL_WALL) && y > 0) { const v = vOf(fvOld[i - w], i - w, i); if (v > 0) v2 += v * v; } // 下方是墙
          if (y === 0 || kind[i - w] === CELL_WALL) { const v = y < h - 1 ? vOf(fvOld[i], i, i + w) : 0; if (v < 0) v2 += v * v; } // 上方是墙
          pi += impact * m * v2;
        }
        p[i] = pi;
      }
    }
    // ---- 水源注入：按 dt 计，否则每帧上百步会把格子灌爆 ----
    // 先灌满水源格本身，满了（≥ m₀）以后的溢出按欧氏距离由近到远补进周围没满的格（圆形外扩）。
    // 只往水源格里加的话，它会远超 m₀、只能沿四条轴向喷，而轴上的格低于 m₀ 不施压、不往两侧推，
    // 惯性把水沿四条轴一路送出去 → 十字形。
    for (let i = 0; i < kind.length; i++) {
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
      if (add > 0) mass[i] += add; // 周围都满了：照常加进水源格，由压力推开
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
        if (kind[i] === CELL_WALL) {
          // 墙：法向速度为 0（不透水）。撞墙的动量由压力接管——冲上来的水被压缩，
          // 压力把它推回去、推向两侧。贴墙那条边也不搬质量。
          fhNext[i] = 0;
          fvNext[i] = 0;
          continue;
        }
        const mi = mass[i];
        if (x < w - 1 && kind[i + 1] !== CELL_WALL) {
          const mj = mass[i + 1];
          const me = Math.max(0.5 * (mi + mj), 1e-3); // 被推动的质量（惯性）
          // 平流的控制体是这条面自己的：左格心 ↔ 右格心。边界上的量由相邻两面插值，
          // 不能直接拿"西邻面/本面"当边界（那等于把控制体西移半格 → 奇偶错位）。
          const PW = x > 0 ? fh[i - 1] : 0;
          const mW = x > 0 ? 0.5 * (mass[i - 1] + mi) : me;
          const PE = x < w - 2 ? fh[i + 1] : 0;
          const mE = x < w - 2 ? 0.5 * (mass[i + 1] + mass[i + 2]) : me;
          let P0 = this.advect(fh[i], PW, mW, PE, mE, me, dt);
          // 二维平流：水平动量也随竖直流动走。控制体上边界（格 i、i+1 上方两条竖直边的平均）流进来的水
          // 带着上一行这条水平边的速度，下边界流出去的水带着本边的速度（迎风）。
          {
            const u = fh[i] / me;
            if (y > 0) {
              const qT = 0.5 * dt * (fv[i - w] + fv[i + 1 - w]); // 正 = 向下流进控制体
              const mT = 0.5 * (mass[i - w] + mass[i + 1 - w]);
              P0 += CROSS * qT * (qT > 0 ? (mT > 1e-6 ? fh[i - w] / mT : 0) : u);
            }
            if (y < h - 1) {
              const qB = 0.5 * dt * (fv[i] + fv[i + 1]); // 正 = 向下流出控制体
              const mB = 0.5 * (mass[i + w] + mass[i + 1 + w]);
              P0 -= CROSS * qB * (qB > 0 ? u : mB > 1e-6 ? fh[i + w] / mB : 0);
            }
          }
          // 内聚只在两侧都有水的边上：水对水的力成对出现、互相抵消，整团水的质心不受影响
          const coh = mi > WET && mj > WET ? q[i] - q[i + 1] : 0;
          // 力推动的是"被推走的那一侧"的水：F > 0 把 i 推向 j，动量增量 ∝ m_i；F < 0 把 j 拉回 i，
          // 动量增量 ∝ m_j——拉一个空格时 m_j = 0，负压拉不出水，也就不会把水粘在空气上。
          const F = p[i] - p[i + 1] + coh;
          const msrc = F > 0 ? mi : mj;
          fhNext[i] = this.limitP(P0 + ((F * msrc) / me) * dt, mi, mj, dt);
        } else {
          fhNext[i] = 0; // 右侧是墙 / 越界：法向速度为 0
        }
        if (y < h - 1 && kind[i + w] !== CELL_WALL) {
          const mj = mass[i + w];
          const me = Math.max(0.5 * (mi + mj), 1e-3);
          const PW = y > 0 ? fv[i - w] : 0;
          const mW = y > 0 ? 0.5 * (mass[i - w] + mi) : me;
          const PE = y < h - 2 ? fv[i + w] : 0;
          const mE = y < h - 2 ? 0.5 * (mass[i + w] + mass[i + 2 * w]) : me;
          let P0 = this.advect(fv[i], PW, mW, PE, mE, me, dt);
          // 二维平流：竖直动量也随水平流动走。控制体左边界（格 i、i+w 左侧两条水平边的平均）流进来的水
          // 带着左一列这条竖直边的速度，右边界流出去的水带着本边的速度（迎风）。
          {
            const u = fv[i] / me;
            if (x > 0) {
              const qL = 0.5 * dt * (fh[i - 1] + fh[i + w - 1]); // 正 = 向右流进控制体
              const mL = 0.5 * (mass[i - 1] + mass[i - 1 + w]);
              P0 += CROSS * qL * (qL > 0 ? (mL > 1e-6 ? fv[i - 1] / mL : 0) : u);
            }
            if (x < w - 1) {
              const qR = 0.5 * dt * (fh[i] + fh[i + w]); // 正 = 向右流出控制体
              const mR = 0.5 * (mass[i + 1] + mass[i + 1 + w]);
              P0 -= CROSS * qR * (qR > 0 ? u : mR > 1e-6 ? fv[i + 1] / mR : 0);
            }
          }
          const coh = mi > WET && mj > WET ? q[i] - q[i + w] : 0;
          const F = p[i] - p[i + w] + coh;
          const msrc = F > 0 ? mi : mj;
          // 重力是体力：作用在上方那格的水上（它要往下掉），动量增量 g·m_i
          fvNext[i] = this.limitP(P0 + ((F * msrc) / me + g * mi) * dt, mi, mj, dt);
        } else {
          fvNext[i] = 0; // 下方是墙 / 越界：法向速度为 0
        }
      }
    }
    fh.set(fhNext);
    fv.set(fvNext);
    // ---- 2.5) 剪切粘性：相邻平行边之间交换动量 ----
    this.applyViscosity(viscosity, dt);
    // ---- 3) 质量按动量迁移：这一步搬走 dt·P（P 本身就是单位时间流过的质量），先全部算完再一次性应用 ----
    const delta = this.deltaBuf;
    delta.fill(0);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const i = row + x;
        if (kind[i] === CELL_WALL) continue;
        // 贴墙 / 越界的那条边不搬质量（它的速度恒为 0，这里再挡一次以防万一）
        const a = fh[i];
        if (a !== 0 && x < w - 1 && kind[i + 1] !== CELL_WALL) {
          const dm = dt * a;
          delta[i] -= dm;
          delta[i + 1] += dm;
        }
        const b = fv[i];
        if (b !== 0 && y < h - 1 && kind[i + w] !== CELL_WALL) {
          const dm = dt * b;
          delta[i] -= dm;
          delta[i + w] += dm;
        }
      }
    }
    for (let i = 0; i < mass.length; i++) {
      const d = delta[i];
      if (d !== 0) mass[i] += d;
    }
  }

  /** 鼠标指到哪一格就读哪一格（调试用；墙 / 越界返回 null） */
  probe(x: number, y: number): CellProbe | null {
    const { w, h, kind, mass } = this;
    if (x < 0 || y < 0 || x >= w || y >= h) return null;
    if (kind[y * w + x] === CELL_WALL) return null;
    const p = this.pressureBuf;
    const fh = this.fhBuf;
    const fv = this.fvBuf;
    const i = y * w + x;
    const solid = (j: number) => j < 0 || j >= w * h || kind[j] === CELL_WALL;
    // 边上存的是动量 P = m·v，读数换回速度 v = P / m_边
    const vel = (P: number, a: number, b: number) => { const me = 0.5 * (mass[a] + mass[b]); return me > 1e-6 ? P / me : 0; };
    const right = x < w - 1 && !solid(i + 1) ? { dp: p[i] - p[i + 1], v: vel(fh[i], i, i + 1) } : { dp: 0, v: 0 };
    const left = x > 0 && !solid(i - 1) ? { dp: p[i] - p[i - 1], v: -vel(fh[i - 1], i - 1, i) } : { dp: 0, v: 0 };
    const down = y < h - 1 && !solid(i + w) ? { dp: p[i] - p[i + w], v: vel(fv[i], i, i + w) } : { dp: 0, v: 0 };
    const up = y > 0 && !solid(i - w) ? { dp: p[i] - p[i - w], v: -vel(fv[i - w], i - w, i) } : { dp: 0, v: 0 };
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
    P: number,
    PW: number,
    mW: number,
    PE: number,
    mE: number,
    mSelf: number,
    dt: number,
  ): number {
    // 两条控制体边界（左格心、右格心）上的质量通量 = 相邻两条边 P 的平均（P 本身就是质量通量）
    const qW = 0.5 * dt * (PW + P); // 西边界，正 = 向东
    const qE = 0.5 * dt * (P + PE); // 东边界，正 = 向东
    // 迎风：每份流过边界的质量带着上游那条边的速度 u = P/m（空边速度为 0）
    const vel = (Pk: number, mk: number) => (mk > 1e-6 ? Pk / mk : 0);
    const uW = qW > 0 ? vel(PW, mW) : vel(P, mSelf);
    const uE = qE > 0 ? vel(P, mSelf) : vel(PE, mE);
    // 直接更新动量：旧动量 + 流入 − 流出。不能先换成速度再除以新质量——下落前沿那条边的质量
    // 一直在涨，"除新质量再乘旧质量"每步都丢动量，水团落得慢一半、还被拉长散开（实测 8 → 30 列）。
    return P + qW * uW - qE * uE;
  }

  /**
   * 剪切粘性：每一对相邻的平行边（侧向一对、顺流一对）按速度差交换动量
   *   J = k · m_共 · (v_a − v_b)，k = VISC_SCALE · viscosity · dt，m_共 = 两边质量的较小者。
   * 一边减多少、另一边就加多少，所以总动量守恒，整体平动（比如自由落体）不受影响——
   * 粘性只抹平相邻流速的差：晃动更快停下、水流像蜂蜜一样被"拖"着走。
   * 只在两边都有水时交换（空气、墙不参与），交换完再做一遍 limitP 保证质量非负。
   */
  private applyViscosity(viscosity: number, dt: number): void {
    const { w, h, mass, kind } = this;
    const k = Math.min(VISC_SCALE * Math.min(Math.max(viscosity, 0), 0.95) * dt, VISC_K_MAX);
    if (k <= 0) return;
    const fh = this.fhBuf;
    const fv = this.fvBuf;
    const nh = this.fhNext;
    const nv = this.fvNext;
    nh.set(fh);
    nv.set(fv);
    // 交换 J = k·m_共·(v_a − v_b)；边的质量 = 两侧格质量平均，空边（< 1e-6）不参与
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const j = row + x;
        if (kind[j] === CELL_WALL) continue;
        // ---- 水平边 j → j+1 ----
        if (x < w - 1 && kind[j + 1] !== CELL_WALL) {
          const ma = 0.5 * (mass[j] + mass[j + 1]);
          if (ma > 1e-6) {
            const va = fh[j] / ma;
            // 侧向：下一行同位置的水平边
            if (y < h - 1 && kind[j + w] !== CELL_WALL && kind[j + w + 1] !== CELL_WALL) {
              const mb = 0.5 * (mass[j + w] + mass[j + w + 1]);
              if (mb > 1e-6) {
                const J = k * (ma < mb ? ma : mb) * (va - fh[j + w] / mb);
                nh[j] -= J;
                nh[j + w] += J;
              }
            }
            // 顺流：右边那条水平边 j+1 → j+2
            if (x < w - 2 && kind[j + 2] !== CELL_WALL) {
              const mb = 0.5 * (mass[j + 1] + mass[j + 2]);
              if (mb > 1e-6) {
                const J = k * (ma < mb ? ma : mb) * (va - fh[j + 1] / mb);
                nh[j] -= J;
                nh[j + 1] += J;
              }
            }
          }
        }
        // ---- 竖直边 j → j+w ----
        if (y < h - 1 && kind[j + w] !== CELL_WALL) {
          const ma = 0.5 * (mass[j] + mass[j + w]);
          if (ma > 1e-6) {
            const va = fv[j] / ma;
            // 侧向：右一列同位置的竖直边
            if (x < w - 1 && kind[j + 1] !== CELL_WALL && kind[j + 1 + w] !== CELL_WALL) {
              const mb = 0.5 * (mass[j + 1] + mass[j + 1 + w]);
              if (mb > 1e-6) {
                const J = k * (ma < mb ? ma : mb) * (va - fv[j + 1] / mb);
                nv[j] -= J;
                nv[j + 1] += J;
              }
            }
            // 顺流：下面那条竖直边 j+w → j+2w
            if (y < h - 2 && kind[j + 2 * w] !== CELL_WALL) {
              const mb = 0.5 * (mass[j + w] + mass[j + 2 * w]);
              if (mb > 1e-6) {
                const J = k * (ma < mb ? ma : mb) * (va - fv[j + w] / mb);
                nv[j] -= J;
                nv[j + w] += J;
              }
            }
          }
        }
      }
    }
    // 交换后再做一遍质量钳制（只对开着的边）
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const j = row + x;
        if (kind[j] === CELL_WALL) continue;
        if (x < w - 1 && kind[j + 1] !== CELL_WALL) nh[j] = this.limitP(nh[j], mass[j], mass[j + 1], dt);
        if (y < h - 1 && kind[j + w] !== CELL_WALL) nv[j] = this.limitP(nv[j], mass[j], mass[j + w], dt);
      }
    }
    fh.set(nh);
    fv.set(nv);
  }

  /**
   * 动量钳制（源格由流向决定：P > 0 是 i，P < 0 是 j）：
   * - 搬运速度 |P| / m_源 ≤ MAX_SPEED：近干的薄水里一点点动量除以很小的质量就是极大的速度
   *   （雨里沿台阶甩出 ~50 格/单位时间的水膜），限住它就不会再"飞"；
   * - 这一步搬走的质量 dt·|P| ≤ m_源 / 4，保证质量恒非负。
   */
  private limitP(P: number, mi: number, mj: number, dt: number): number {
    if (P > 0) return Math.min(P, MAX_SPEED * mi, (0.25 * mi) / dt);
    if (P < 0) return -Math.min(-P, MAX_SPEED * mj, (0.25 * mj) / dt);
    return 0;
  }
}
