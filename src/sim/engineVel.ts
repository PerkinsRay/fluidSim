/**
 * 速度版引擎（Edge Velocity）—— engineSimple 的复制，唯一区别是边上存**速度**而非动量。
 *
 * 算法完全不变：守恒的动量平流（moved）、源格质量定比例、两步迎风交叉项、
 * 各向同性限速、剪切粘性、质量通量 dm = dt·P。
 *
 * 转换放在子步内部：
 *   开头 P = u · m_e（当前质量） → 原样跑完整套算法 → 末尾 u = P / m_e（**更新后**质量）
 * 往返精确，与存动量等价。好处是边速度成为一等状态量（readonly uh / uv），
 * 外部读取不必再做 P/m_e 的换算。
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
 *
 * 注意这个上限要按**合速度** |(u,v)| 施加，不能对 fh、fv 各自限 —— 分量各限会让斜向的
 * 合速度达到 MAX_SPEED·√2，结构上允许对角比轴向快 41%，远场真空里水团因此长成方形
 * （比值 1.28 ≈ √2 的方向）。按合速度限制后是 0.98，接近圆。见 advanceSub 里的等比缩放。
 */
const MAX_SPEED = 12;



/**
 * 二维平流里垂直方向那一项（交叉项）的系数 —— 形状与守恒的权衡旋钮。
 *
 * 交叉项把 x 动量沿 y 方向搬运，守恒性要求有它；但它由轴对齐的通量拼出来，会优先
 * 往对角喂质量，偏差随传播距离累积。真空里单格水团的 对角/轴向 半径比（步 400）：
 *   CROSS=0 → 1.09（圆）· 0.4 → 1.16 · 0.6 → 1.24 · 1 → 1.30（方形，√2=1.41）
 * 代价（剪切层 x 动量漂移，应为 0 / 45° 匀速平移，精确 9.0）：
 *   CROSS=0 → 68.56 / 7.7 · 0.4 → 7.89 / 8.8 · 0.6 → 2.30 / 8.9 · 1 → 0.00 / 8.9
 *
 * 当前取 1：守恒优先（剪切漂移 0.00、45° 平移 8.9/9.0）。方形不靠调它来修 ——
 * 真正的根因是限速各向异性，见 limitP 上方的"各向同性限速"（远场真空 1.28 → 0.98）。
 *
 * 注：形状必须在**远场**量（步 400 级别）。近场（步 25）各向异性还没长出来，
 * 会读到假的 1.00 —— 这里的结论早期被这个坑误导过多次。
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
  for (let dy = -r; dy <= r; dy++)
    for (let dx = -r; dx <= r; dx++)
      if (dx * dx + dy * dy <= r * r) out.push([dx, dy]);
  return out.sort(
    (a, b) => a[0] * a[0] + a[1] * a[1] - (b[0] * b[0] + b[1] * b[1]),
  );
})();

export class FluidEngineVel extends FluidEngine {
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
  /**
   * 每条边的**速度**（跨步保留的状态量）：uh[i] 右边 i→i+1，uv[i] 下边 i→i+w。
   * 这是与 engineSimple 的唯一区别 —— 那边存的是动量 P = m·v。
   */
  readonly uh: Float32Array;
  readonly uv: Float32Array;
  /**
   * 子步内的**动量工作区**，不是跨步状态：开头由 uh/uv × m_e 重建，末尾换回速度后作废。
   * 之所以保留，是因为整套算法（moved / limitP / 交叉项 / 粘性）都在动量上运算 ——
   * 守恒平流要求被搬运的量是动量。若改成直接在速度上运算就必须放弃守恒形式
   * （那是 engineAvg，实测落体慢 14%、闪烁高一倍）。
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
  /** 各向同性限速的缩放系数（先算完再统一应用，避免依赖扫描顺序） */
  private capH: Float32Array;
  private capV: Float32Array;

  constructor(w: number, h: number) {
    super(w, h);
    this.pressureBuf = new Float32Array(w * h);
    this.cohBuf = new Float32Array(w * h);
    this.uh = new Float32Array(w * h);
    this.uv = new Float32Array(w * h);
    this.fhBuf = new Float32Array(w * h);
    this.fvBuf = new Float32Array(w * h);
    this.fhNext = new Float32Array(w * h);
    this.fvNext = new Float32Array(w * h);
    this.deltaBuf = new Float32Array(w * h);
    this.capH = new Float32Array(w * h);
    this.capV = new Float32Array(w * h);
  }

  override clear(): void {
    super.clear();
    this.uh.fill(0);
    this.uv.fill(0);
    // fhBuf / fvBuf 是子步内的工作区，每步开头都会由 uh/uv 重建，无需清零
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
    const { w, h, mass, kind, uh, uv } = this;
    const { gravity, expansion, restDensity, viscosity } = this.params;
    // 压力系数（见 C_SCALE）：滑杆 2（默认）→ c = 200，64 格深的水压缩 < 10%。
    const c = Math.max(expansion, 0) * C_SCALE;
    const g = Math.max(gravity, 0);
    const m0 = Math.max(restDensity, 0);
    // 内聚强度（见 COH_SCALE）：只在有静止密度时才有意义（双井的两个井底是 0 与 m₀）
    // 两半分开调：u < 0.5 的推力瓣用 thinPush，u > 0.5 的拉力瓣用 tension
    const cohPush =
      m0 > 0 ? Math.max(this.params.thinPush ?? 0, 0) * COH_SCALE : 0;
    const cohPull =
      m0 > 0 ? Math.max(this.params.tension ?? 0, 0) * COH_SCALE : 0;
    const ampPush = cohPush * m0;
    const ampPull = cohPull * m0;
    // 声速 CFL：dt ≤ 0.5/√(2S + g)，S = 最硬段的斜率（双井在 u=0 处斜率 cohPush，u=1 处 cohPull）
    const stiff = Math.max(c, cohPush, cohPull);
    const dt = Math.min(timeStep, 0.5 / Math.sqrt(2 * stiff + g + 1e-6));

    // ---- 0) 速度 → 动量：用**当前**边质量重建，之后的算法与 engineSimple 完全一致 ----
    const edgeMass = (a: number, b: number): number => 0.5 * (mass[a] + mass[b]);
    {
      const fh0 = this.fhBuf;
      const fv0 = this.fvBuf;
      for (let y = 0; y < h; y++) {
        const row = y * w;
        for (let x = 0; x < w; x++) {
          const i = row + x;
          const okH = x < w - 1 && kind[i] !== CELL_WALL && kind[i + 1] !== CELL_WALL;
          const okV = y < h - 1 && kind[i] !== CELL_WALL && kind[i + w] !== CELL_WALL;
          fh0[i] = okH ? uh[i] * edgeMass(i, i + 1) : 0;
          fv0[i] = okV ? uv[i] * edgeMass(i, i + w) : 0;
        }
      }
    }

    // ---- 1) 每格压力 p（状态方程）+ 内聚压力 q（双井，只读质量，与扫描顺序无关）----
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
          // 与 engineSimple 逐字一致：由动量反推速度 v = P / m_边，并沿用它的 1e-6 门限。
          // 直接写 uh[i−1] 在数学上等价（uh = P/m_e），但门限不同（1e-9 vs 1e-6），
          // 极稀薄的边上两者会给出不同结果 —— 等价性要求连门限都照抄。
          const vOf = (P: number, a: number, b: number) => {
            const me = 0.5 * (mass[a] + mass[b]);
            return me > 1e-6 ? P / me : 0;
          };
          if ((x === w - 1 || kind[i + 1] === CELL_WALL) && x > 0) {
            const v = vOf(this.fhBuf[i - 1], i - 1, i);
            if (v > 0) v2 += v * v;
          } // 右侧是墙
          if (x === 0 || kind[i - 1] === CELL_WALL) {
            const v = x < w - 1 ? vOf(this.fhBuf[i], i, i + 1) : 0;
            if (v < 0) v2 += v * v;
          } // 左侧是墙
          if ((y === h - 1 || kind[i + w] === CELL_WALL) && y > 0) {
            const v = vOf(this.fvBuf[i - w], i - w, i);
            if (v > 0) v2 += v * v;
          } // 下方是墙
          if (y === 0 || kind[i - w] === CELL_WALL) {
            const v = y < h - 1 ? vOf(this.fvBuf[i], i, i + w) : 0;
            if (v < 0) v2 += v * v;
          } // 上方是墙
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
          // 沿本方向平流（直接搬动量，见 moved）：本边交出自己那一份，
          // 再收下左邻边（向右流时）和右邻边（向左流时）交过来的那一份。贴墙的邻边 P 恒为 0。
          const PW = x > 0 ? fh[i - 1] : 0; // 左邻边 i−1 → i，源格 i−1
          const PE = x < w - 1 ? fh[i + 1] : 0; // 右邻边 i+1 → i+2（与左邻 x>0 对称）
          let P0 =
            fh[i] -
            this.moved(fh[i], fh[i] > 0 ? mi : mj, dt) +
            (PW > 0 ? this.moved(PW, mass[i - 1], dt) : 0) +
            (PE < 0 ? this.moved(PE, x < w - 2 ? mass[i + 2] : mj, dt) : 0);
          // 二维平流：水平动量也随竖直流动走。横向通量取**源侧**那条竖直边的全量（迎风），
          // 不取两条的平均——平均会少搬一点（45° 匀速平移实测 8.9 格，精确解 9.0；
          // 取源侧全量正好 9.0，取源侧一半则只有 8.5）。
          {
            // 两步迎风：先由 fh 符号定出水平动量的源格 src，再由 fv 符号定出该 u 往哪搬
            const src = fh[i] >= 0 ? i : i + 1;
            if (y > 0) {
              const qT = dt * fv[src - w];
              let uT: number;
              // fh 存在**边**上，fh[格号] 取的是该格右侧那条边，不是该格的水平动量 ——
              // 直接用会让两条镜像边取到同一条边、加上同一个值（而非相反数），镜像因此破掉。
              // 格心水平动量 = 该格左右两条边的平均。
              const cu = (g: number) => 0.5 * ((g % w > 0 ? fh[g - 1] : 0) + (g % w < w - 1 ? fh[g] : 0));
              if (qT > 0) {
                const mUp = mass[src - w];
                uT = mUp > 1e-6 ? cu(src - w) / mUp : 0;
              } else {
                const mSrc = mass[src];
                uT = mSrc > 1e-6 ? cu(src) / mSrc : 0;
              }
              P0 += CROSS * qT * uT;
            }
            if (y < h - 1) {
              const qB = dt * fv[src];
              let uB: number;
              const cu2 = (g: number) => 0.5 * ((g % w > 0 ? fh[g - 1] : 0) + (g % w < w - 1 ? fh[g] : 0));
              if (qB > 0) {
                const mSrc = mass[src];
                uB = mSrc > 1e-6 ? cu2(src) / mSrc : 0;
              } else {
                const mBot = mass[src + w];
                uB = mBot > 1e-6 ? cu2(src + w) / mBot : 0;
              }
              P0 -= CROSS * qB * uB;
            }
          }
          // 内聚只在两侧都有水的边上：水对水的力成对出现、互相抵消，整团水的质心不受影响
          const coh = mi > WET && mj > WET ? q[i] - q[i + 1] : 0;
          // 压差是冲量：dP = F·dt，与质量无关（原来还除以 m_边，是多余的）。
          // 但源格必须有水：F > 0 把 i 推向 j，源格是 i；F < 0 把 j 拉回 i，源格是 j——
          // 拉一个空格时源格为空，负压拉不出水，也就不会把水粘在空气上。
          const F = p[i] - p[i + 1] + coh;
          const msrc = F > 0 ? mi : mj;
          fhNext[i] = this.limitP(P0 + (msrc > 1e-9 ? F : 0) * dt, mi, mj, dt);
        } else {
          fhNext[i] = 0; // 右侧是墙 / 越界：法向速度为 0
        }
        if (y < h - 1 && kind[i + w] !== CELL_WALL) {
          const mj = mass[i + w];
          const PW = y > 0 ? fv[i - w] : 0; // 上邻边 i−w → i，源格 i−w
          const PE = y < h - 1 ? fv[i + w] : 0; // 下邻边 i+w → i+2w（与上邻 y>0 对称）
          let P0 =
            fv[i] -
            this.moved(fv[i], fv[i] > 0 ? mi : mj, dt) +
            (PW > 0 ? this.moved(PW, mass[i - w], dt) : 0) +
            (PE < 0 ? this.moved(PE, y < h - 2 ? mass[i + 2 * w] : mj, dt) : 0);
          // 二维平流：竖直动量也随水平流动走。横向通量同样取源侧那条水平边的全量（迎风）。
          {
            // 两步迎风（竖直边的镜像）：src 由 fv 符号定，v 的取向由 fh 符号定
            const src = fv[i] >= 0 ? i : i + w;
            if (x > 0) {
              const qL = dt * fh[src - 1];
              let vL: number;
              const cv = (g: number) => 0.5 * ((g >= w ? fv[g - w] : 0) + (g < w * h - w ? fv[g] : 0));
              if (qL > 0) {
                const mLc = mass[src - 1];
                vL = mLc > 1e-6 ? cv(src - 1) / mLc : 0;
              } else {
                const mSrc = mass[src];
                vL = mSrc > 1e-6 ? cv(src) / mSrc : 0;
              }
              P0 += CROSS * qL * vL;
            }
            if (x < w - 1) {
              const qR = dt * fh[src];
              let vR: number;
              const cv2 = (g: number) => 0.5 * ((g >= w ? fv[g - w] : 0) + (g < w * h - w ? fv[g] : 0));
              if (qR > 0) {
                const mSrc = mass[src];
                vR = mSrc > 1e-6 ? cv2(src) / mSrc : 0;
              } else {
                const mRc = mass[src + 1];
                vR = mRc > 1e-6 ? cv2(src + 1) / mRc : 0;
              }
              P0 -= CROSS * qR * vR;
            }
          }
          const coh = mi > WET && mj > WET ? q[i] - q[i + w] : 0;
          const F = p[i] - p[i + w] + coh;
          const msrc = F > 0 ? mi : mj;
          // 重力是体力：作用在上方那格的水上（它要往下掉），动量增量 g·m_i
          fvNext[i] = this.limitP(
            P0 + ((msrc > 1e-9 ? F : 0) + g * mi) * dt,
            mi,
            mj,
            dt,
          );
        } else {
          fvNext[i] = 0; // 下方是墙 / 越界：法向速度为 0
        }
      }
    }
    // 各向同性限速（逐边、与扫描顺序无关）：分量各限 MAX_SPEED 会让斜向合速度达
    // MAX_SPEED·√2，结构上允许对角比轴向快 41% → 远场水团长成方形。按合速度限制消掉它。
    // 必须先把缩放系数全部算完、再统一应用：原地改 fhNext/fvNext 会让后扫到的边读到
    // 已被缩放的邻边值，结果依赖扫描顺序（实测上下不对称 2.2e-2，而左右只有 3.8e-6）。
    {
      const sh = this.capH;
      const sv = this.capV;
      sh.fill(1);
      sv.fill(1);
      for (let y = 0; y < h; y++) {
        const row = y * w;
        for (let x = 0; x < w; x++) {
          const i = row + x;
          if (kind[i] === CELL_WALL) continue;
          if (x < w - 1 && kind[i + 1] !== CELL_WALL) {
            const me = 0.5 * (mass[i] + mass[i + 1]);
            if (me > 1e-9) {
              const u = fhNext[i] / me;
              const vA = y > 0 ? 0.5 * (fvNext[i - w] + fvNext[i]) : fvNext[i];
              const vB = y > 0 ? 0.5 * (fvNext[i + 1 - w] + fvNext[i + 1]) : fvNext[i + 1];
              const sp = Math.hypot(u, 0.5 * (vA + vB) / me);
              if (sp > MAX_SPEED) sh[i] = MAX_SPEED / sp;
            }
          }
          if (y < h - 1 && kind[i + w] !== CELL_WALL) {
            const me = 0.5 * (mass[i] + mass[i + w]);
            if (me > 1e-9) {
              const v = fvNext[i] / me;
              const uA = x > 0 ? 0.5 * (fhNext[i - 1] + fhNext[i]) : fhNext[i];
              const uB = x > 0 ? 0.5 * (fhNext[i + w - 1] + fhNext[i + w]) : fhNext[i + w];
              const sp = Math.hypot(0.5 * (uA + uB) / me, v);
              if (sp > MAX_SPEED) sv[i] = MAX_SPEED / sp;
            }
          }
        }
      }
      for (let i = 0; i < fhNext.length; i++) {
        if (sh[i] !== 1) fhNext[i] *= sh[i];
        if (sv[i] !== 1) fvNext[i] *= sv[i];
      }
    }
    fh.set(fhNext);
    fv.set(fvNext);
    // ---- 2.5) 剪切粘性：相邻平行边之间交换动量 ----
    this.applyViscosity(viscosity, dt);
    // ---- 3) 质量迁移：dm = dt·P，与 engineSimple **逐字相同** ----
    // 这一步必须照抄原版。曾经"改进"成 dm = dt·v·m_源（理由是"真正跨过这条边的是源格
    // 的物质"），那不是换表示、而是换算法 —— 实测剪切漂移 2.9e-3 → 3.9e+0、落体 32.04 →
    // 32.64、闪烁翻四倍。等价性的前提是：**只改状态量的存法，一条公式都不动**。
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

    // ---- 4) 动量 → 速度：必须用**更新后**的边质量 ----
    // 用旧质量会在质量变化处放大速度（水团上沿流走后 m_e 变小，u = P/m_e 被抬高），
    // 实测自由落体会超速 65%。
    {
      for (let y = 0; y < h; y++) {
        const row = y * w;
        for (let x = 0; x < w; x++) {
          const i = row + x;
          const okH = x < w - 1 && kind[i] !== CELL_WALL && kind[i + 1] !== CELL_WALL;
          const okV = y < h - 1 && kind[i] !== CELL_WALL && kind[i + w] !== CELL_WALL;
          const meH = okH ? edgeMass(i, i + 1) : 0;
          const meV = okV ? edgeMass(i, i + w) : 0;
          uh[i] = meH > 1e-9 ? fh[i] / meH : 0;
          uv[i] = meV > 1e-9 ? fv[i] / meV : 0;
        }
      }
    }
  }

  /** 鼠标指到哪一格就读哪一格（调试用；墙 / 越界返回 null） */
  probe(x: number, y: number): CellProbe | null {
    const { w, h, kind, mass } = this;
    if (x < 0 || y < 0 || x >= w || y >= h) return null;
    if (kind[y * w + x] === CELL_WALL) return null;
    const p = this.pressureBuf;
    const uh = this.uh;
    const uv = this.uv;
    const i = y * w + x;
    const solid = (j: number) => j < 0 || j >= w * h || kind[j] === CELL_WALL;
    // 边上直接存速度，不必再做 P / m_边 的换算（uh/uv 就是上一步末尾算好的速度）
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
   * 沿本方向的动量平流（直接搬动量，一阶迎风）：一条边这一步搬走的质量是 dt·|P|，
   * 占源格质量的比例 f = dt·|P| / m_源；这些水带着的动量 f·P = P·|P|·dt / m_源，交给流向那一侧的下一条边：
   *   P[i] += moved(P[i−1])（P[i−1] > 0，从左边流进来）
   *         − moved(P[i])
   *         + moved(P[i+1])（P[i+1] < 0，从右边流进来）
   * 一边减多少另一边加多少，动量守恒。用 P·|P| 而不是 P²：向左流（P < 0）时搬走的是负动量。
   * f 封顶 1：limitP 已保证 f ≤ 1/4，封顶只防迁移后源格变空（m_源 → 0）时除出无穷大。
   */
  private moved(P: number, mSrc: number, dt: number): number {
    if (P === 0) return 0;
    const f = mSrc > 1e-9 ? Math.min(1, (Math.abs(P) * dt) / mSrc) : 1;
    return f * P;
  }

  /**
   * 剪切粘性：每一对相邻的平行边（侧向一对、顺流一对）按速度差交换动量
   *   J = k · m_共 · (v_a − v_b)，k = VISC_SCALE · viscosity · dt，m_共 = 两边质量的较小者。
   * 一边减多少、另一边就加多少，所以总动量守恒，整体平动（比如自由落体）不受影响——
   * 粘性只抹平相邻流速的差：晃动更快停下、水流像蜂蜜一样被"拖"着走。
   * 两边都有水才交换（空气不参与），交换完再做一遍 limitP 保证质量非负。
   *
   * 墙当作"速度 0、质量无穷大"的水：边的某个平行邻边贴墙（或越界）时，
   * J = k·min(m, ∞)·(v − 0) = k·P，这份动量被墙吸收、墙的速度不变。四个方向（侧向两条、顺流两条）都算。
   * 墙的拖拽再乘 (1 − wallBounce)：反弹 0 时墙完全不滑（晃动被墙磨停）；反弹 1 时墙是光滑的，
   * 撞墙的水不会被墙吸走动量，压力才能把它推回去。
   */
  private applyViscosity(viscosity: number, dt: number): void {
    const { w, h, mass, kind } = this;
    const k = Math.min(
      VISC_SCALE * Math.min(Math.max(viscosity, 0), 0.95) * dt,
      VISC_K_MAX,
    );
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
            if (
              y < h - 1 &&
              kind[j + w] !== CELL_WALL &&
              kind[j + w + 1] !== CELL_WALL
            ) {
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
            if (
              x < w - 1 &&
              kind[j + 1] !== CELL_WALL &&
              kind[j + 1 + w] !== CELL_WALL
            ) {
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
    // 墙 = 速度 0、质量无穷大的水：每个贴墙 / 越界的平行邻边吸收 kw·P（kw = k·(1 − 反弹)）
    const kw = k * (1 - Math.min(Math.max(this.params.wallBounce ?? 0, 0), 1));
    for (let y = 0; kw > 0 && y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const j = row + x;
        if (kind[j] === CELL_WALL) continue;
        // 水平边 j → j+1
        if (x < w - 1 && kind[j + 1] !== CELL_WALL && fh[j] !== 0) {
          let n = 0;
          if (
            y === 0 ||
            kind[j - w] === CELL_WALL ||
            kind[j - w + 1] === CELL_WALL
          )
            n++; // 上
          if (
            y === h - 1 ||
            kind[j + w] === CELL_WALL ||
            kind[j + w + 1] === CELL_WALL
          )
            n++; // 下
          if (x === 0 || kind[j - 1] === CELL_WALL) n++; // 左（j−1 → j）
          if (x + 2 >= w || kind[j + 2] === CELL_WALL) n++; // 右（j+1 → j+2）
          if (n) nh[j] -= kw * n * fh[j];
        }
        // 竖直边 j → j+w
        if (y < h - 1 && kind[j + w] !== CELL_WALL && fv[j] !== 0) {
          let n = 0;
          if (
            x === 0 ||
            kind[j - 1] === CELL_WALL ||
            kind[j - 1 + w] === CELL_WALL
          )
            n++; // 左
          if (
            x === w - 1 ||
            kind[j + 1] === CELL_WALL ||
            kind[j + 1 + w] === CELL_WALL
          )
            n++; // 右
          if (y === 0 || kind[j - w] === CELL_WALL) n++; // 上（j−w → j）
          if (y + 2 >= h || kind[j + 2 * w] === CELL_WALL) n++; // 下（j+w → j+2w）
          if (n) nv[j] -= kw * n * fv[j];
        }
      }
    }
    // 交换后再做一遍质量钳制（只对开着的边）
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const j = row + x;
        if (kind[j] === CELL_WALL) continue;
        if (x < w - 1 && kind[j + 1] !== CELL_WALL)
          nh[j] = this.limitP(nh[j], mass[j], mass[j + 1], dt);
        if (y < h - 1 && kind[j + w] !== CELL_WALL)
          nv[j] = this.limitP(nv[j], mass[j], mass[j + w], dt);
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
