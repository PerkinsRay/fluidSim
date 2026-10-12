/**
 * 方格流体模拟引擎（Cellular Fluid Engine）
 *
 * 纯 TypeScript 模块，与渲染完全解耦。
 * 三条规则（严格对应 design/home.md 的 S0 规格）：
 *
 * 规则1 · 压力反作用（对冲交叉传递）：
 *   每格把竖向一对收到的压力取较小值（对冲分量 vs = min(pU, pD)）传给左右两侧，
 *   把横向一对的较小值（hs = min(pL, pR)）传给上下两侧，各乘弹性反馈比例 ρ = k/(k+1)：
 *   竖直面压力 = ρ·hs，水平面压力 = ρ·vs。弹性系数 k 越大，反馈比例越接近 1
 *   （完全反作用 = 不可压缩极限），永不超过——弹性是"硬度"，不是能量放大器。
 *   只有对冲（两侧对等）的压力才会传到侧向：单侧压来的净分量不向侧向泄漏，所以
 *   自由下落的水团不会自加压、不侧向膨胀；被下方顶住的液体形成完整对冲，压力照常
 *   向四周传递（池底摊开、液面摊平）。每格自身质量也算一份压力 α·m·g（α = selfBase），
 *   叠加到"上方来压"上——否则液面处竖向对冲为 0、压力链断开。
 *
 * 规则2 · 压差流动（两遍扫描）：
 *   第一遍算出每格净压力 netP（受力反作用 + 固有膨胀）；第二遍对每条边比较两侧净压力，
 *   垂直边上方格再加自重 m·g，水从高压流向低压：流量 = 压差 × flowScale。
 *   1/4 规则：flowScale ≤ 0.25/S（流完后压差不反号），每条边 ≤ 源格质量/4（质量恒非负）。
 *   → 接近平衡时压差趋零，流量随之趋零，模拟自然静止而非振荡。
 *
 * 规则3 · 永恒重力：
 *   每格对下方邻居额外施加 p_down += mass * g 的恒定压力，
 *   使液体自然下落、在低处堆积、沿容器摊平（产生自上而下的密度梯度）。
 *
 * 物质守恒：每步使用流量场一次性迁移质量，除画笔 / 水源 / 橡皮外严格守恒。
 *
 * 固有膨胀系数 β（params.expansion，连续参数，0 = 关闭）：
 *   每格与受力无关的自发压力：m·β/4 推向四个面 + 规则3的重力 m·g 向下。
 *   固有项与弹性系数 k 完全解耦——k 只缩放受力反作用部分，调大 k 不会让水"沸腾"。
 *   β = 0：唯一自发的力是向下的重力压力；四面的反作用力完全来自实际收到的
 *   压力——竖直面压力 = ρ·min(pL,pR)，水平面压力 = ρ·min(pU,pD)，向下面再加 m·g。收到压力 =
 *   持久压力场（上一帧邻居面输出的阻尼传递，逐帧累加）。每个液体格把自重 m·g 压给
 *   下方。流动卸压：四个方向的输出压力（含自重）都乘以静止比例 1 − 上一步流出量/m，
 *   流出量为四个方向流出之和（穿流的液体也会流出，同样计入）。正在流动的液体不向
 *   任何方向施压，静止的液体全部压出去。
 *   墙格 / 域边界把收到的压力（含自重）原样退回，再沿流体逐格回传累加出深度压力梯度。
 *   下落的水团下方没有回压 → 竖向对冲为 0 → 侧向无推力 → 不散开；
 *   被静止水柱压着的格子上下形成完整对冲 → 压力向四周传递 → 池底摊开。
 *   β > 0：叠加固有膨胀项，空中的水会散开，β 越大散得越快。
 *   反馈阻尼 damp = 0.97：反作用压力逐帧传递构成反馈回路，回路增益
 *   ρ·damp ≤ 0.97 < 1，保证任意弹性系数下压力场收敛不振荡（数值细节，不改变语义）。
 */

export interface SimParams {
  /** 弹性系数 k（受压反作用的"硬度"：反馈比例 ρ = k/(k+1)，k→∞ 趋近完全反作用） */
  elasticity: number;
  /** 粘稠度 0..0.95（阻碍流动的程度） */
  viscosity: number;
  /** 重力 g（每格对下方施加的恒定压力） */
  gravity: number;
  /** 固有膨胀系数 β ≥ 0：每格向四方向自发施压 m·β/4；0 = 仅重力自发向下 */
  expansion: number;
  /**
   * 压力更新间隔 K ≥ 1：质量每个子步都在流，但压力场每 K 个子步才重解一次，
   * 于是"力"往前传播的速度降为 1/K（1 = 每个子步都解，即现状）。
   * 用来把"力传得多快"和"力传得多远"（FEEDBACK_DAMP）分开调。
   */
  pressureEvery: number;
  /**
   * 静止密度 m₀ ≥ 0（0 = 关闭）：质量低于 m₀ 的格**不施加反作用力**（受压不再回推，
   * 只保留自重与固有膨胀）——稀薄的水失去支撑，会自由下落汇回水体，而不是挂在液面上方成雾。
   * 等效于给流体一个"偏好的密度"：高于 m₀ 才是液体，低于 m₀ 只是水汽。
   */
  restDensity: number;
  /**
   * 自重压力系数 α ≥ 0：每格自身质量也算一份压力 α·m·g，叠加在"上方来压"上再取对冲。
   * 0 = 不加（液面处竖向对冲为 0、压力链断开：水位低、水体实、液面锐利）；
   * 0.5 ≈ 原各向同性行为；1 或更大 = 液柱更硬、液面上方雾状水汽更厚。
   */
  selfBase: number;
  /**
   * 撞墙反弹系数 0..1（试验引擎用）：墙只给力、不改速度——水冲向墙时，贴墙格
   * 额外受到冲击压力 2·wallBounce·m·v²。0 = 只有普通压力；1 = 完全反射的冲击力。
   */
  wallBounce: number;
  /**
   * 内聚拉力 0..1（试验引擎用）：双井势 p = A·u(1−u)(1−2u) 中 u > 0.5 的拉力瓣，
   * A = tension × 20 × m₀。0 = 关闭。
   */
  tension: number;
  /**
   * 稀相推力 0..1（试验引擎用）：双井势中 u < 0.5 的推力瓣，A = thinPush × 20 × m₀。0 = 关闭。
   */
  thinPush: number;
}

export const DEFAULT_PARAMS: SimParams = {
  // 水几乎不可压缩：k 取很大，ρ = k/(k+1) ≈ 0.999
  elasticity: 999,
  viscosity: 0.1,
  gravity: 1.0,
  // 试验引擎里是压力系数 c 的 1/100（见 engineSimple 的 C_SCALE）：2 → c = 200
  expansion: 2,
  selfBase: 1.0,
  restDensity: 1,
  pressureEvery: 1,
  wallBounce: 0,
  tension: 0,
  thinPush: 0,
};

/** 画布内部渲染尺寸的目标边长（像素）：网格×每格像素 ≈ 这个数，与网格无关 */
export const RENDER_PX = 1024;

/**
 * 每格占几个像素 = RENDER_PX / 网格较长边（至少 1）。
 * 由"画布内部渲染尺寸恒定"反推得来：网格越细，每格画的像素越少。显示尺寸本来就跟着面板走，
 * 把每格写死成固定像素只是白白多写几倍像素、再让浏览器缩回去（256×256 时是 16 MB/帧）。
 */
function cellSizeFor(w: number, h: number): number {
  return Math.max(1, Math.floor(RENDER_PX / Math.max(w, h)));
}

/** 格子类型（FluidEngine.kind 的取值）：水源本身也是能装水的格，只是每步额外注水 */
export const CELL_FLUID = 0;
export const CELL_WALL = 1;
export const CELL_SOURCE = 2;

/** 渲染时认为是“空格”的质量阈值 */
export const RENDER_EMPTY_EPS = 0.01;

/** 单步流量绝对上限（防御性钳制，避免极端参数下的数值爆炸） */
const MAX_FLOW = 640000;

/** 低于此质量视为空格（不参与压力与流动） */
const EMPTY_EPS = 1e-9;


/** 压力反馈阻尼：回路增益 ρ·damp ≤ 0.97 < 1 */
const FEEDBACK_DAMP = 0.97;

/** 静止比例的低通系数：每步向新值靠近的比例（越小卸压越平滑、越不易振荡） */
const STILL_SMOOTHING = 0.1;

/** 每帧最多子步数（性能上限：damp=0.97 时 k=999 需 89～97 个子步，按 60fps 预算截到 56） */
const MAX_SUBSTEPS = 56;

/**
 * 流量系数。
 * base：期望的每帧流量系数（粘稠度 × 松弛 / 高重力欠松弛），决定水运动的快慢。
 * capped：单个子步的稳定上限（1/4 规则）。流走 q 会让本边压差最终变化约 q·S；压力回路
 *   把反作用放大 A = 1/(1−ρ·damp) 倍（k=999 时 A≈32），S = (ρ·A + β)/2 + g·A。
 *   一格有四条边同时流动，最坏（棋盘分布）时压差变化被放大 4 倍，所以取 0.25/S：
 *   流完后压差最多到 0、不反号 → 相邻格不会一步满一步空（黑白棋盘闪烁）。
 */
function flowScales(p: SimParams, relaxation: number): { base: number; capped: number } {
  const k = Math.max(p.elasticity, 1e-6);
  const beta = Math.max(p.expansion, 0);
  const rho = k / (k + 1);
  // 有效松弛系数：固有膨胀越大系统越刚性，ω 需相应减小以保证 Jacobi 式更新收敛
  const omega = Math.max(0.05, Math.min(relaxation, 0.65 / Math.max(1, beta)));
  // g > 1 时按比例欠松弛（g ≤ 1 时行为不变），保证高重力下收敛静止
  const base =
    ((1 - Math.min(Math.max(p.viscosity, 0), 0.95)) * omega) / Math.max(1, p.gravity);
  const amp = 1 / (1 - rho * FEEDBACK_DAMP);
  const stiffness = (rho * amp + beta) / 2 + Math.max(p.gravity, 0) * amp;
  return { base, capped: Math.min(base, 0.25 / stiffness) };
}

/**
 * 单边流量（带符号，正值 i→j）：压差 × flowScale，不超过源格质量的 1/4。
 * 每条边 ≤ 源格质量/4，四条边合计不超过本格质量，质量恒非负，无需总流出钳制。
 */
function edgeFlow(F: number, mi: number, mj: number, flowScale: number): number {
  if (F > 0) return Math.min(F * flowScale, mi * 0.25, MAX_FLOW);
  if (F < 0) return -Math.min(-F * flowScale, mj * 0.25, MAX_FLOW);
  return 0;
}

export class FluidEngine {
  readonly w: number;
  readonly h: number;
  /** 每格占几个像素（画布内部渲染分辨率 = 网格 × cell） */
  readonly cell: number;

  /** 液体质量场 */
  readonly mass: Float32Array;
  /** 格子类型：CELL_FLUID（可装水）/ CELL_WALL（固体墙）/ CELL_SOURCE（每步注水的格，本身也可装水） */
  readonly kind: Uint8Array;
  /** 四方向压力缓存 [上, 下, 左, 右] × 每格（规则1/3 的输出） */
  readonly pressure: Float32Array;

  /** 流量缓冲：flow[i*2+0] 水平边（i→i+1），flow[i*2+1] 垂直边（i→i+w）；下一步也用于计算静止比例 */
  private flow: Float32Array;
  /** 每格竖直面压力（上下两面的输出，向下面再加 m·g） */
  private netP: Float32Array;
  /** 每格水平面压力（左右两面的输出） */
  private netPH: Float32Array;
  /** 下一帧压力场的重建缓冲（阻尼传递的目标） */
  private pressureNext: Float32Array;
  /** 本笔已经画过水的格（一笔里每格只加一次） */
  private strokeMask: Uint8Array;
  /** 每格静止比例（流动卸压，低通平滑后的 1 − 流出量/m） */
  private still: Float32Array;

  params: SimParams = { ...DEFAULT_PARAMS };
  stepCount = 0;
  /** 水源每步注入量 */
  sourceRate = 3.35;
  /**
   * 松弛因子 ω：Jacobi 式同步更新的欠松弛系数（<1 抑制刚性耦合导致的振荡，
   * 保证平衡后趋于静止）。属于数值求解细节，不改变三条规则的语义。
   */
  relaxation = 0.5;

  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.cell = cellSizeFor(w, h);
    const n = w * h;
    this.mass = new Float32Array(n);
    this.kind = new Uint8Array(n); // 全部 CELL_FLUID
    this.pressure = new Float32Array(n * 4);
    this.flow = new Float32Array(n * 2);
    this.netP = new Float32Array(n);
    this.netPH = new Float32Array(n);
    this.pressureNext = new Float32Array(n * 4);
    this.strokeMask = new Uint8Array(n);
    this.still = new Float32Array(n).fill(1);
  }

  clear(): void {
    this.mass.fill(0);
    this.kind.fill(CELL_FLUID);
    this.pressure.fill(0);
    this.flow.fill(0);
    this.netP.fill(0);
    this.netPH.fill(0);
    this.pressureNext.fill(0);
    this.still.fill(1);
    this.stepCount = 0;
  }

  totalMass(): number {
    let sum = 0;
    const m = this.mass;
    for (let i = 0; i < m.length; i++) sum += m[i];
    return sum;
  }

  /**
   * 执行一步模拟（一帧的推进量）。
   * 刚度上限把单个子步的流量压得很小（k=999 时约为期望值的 1/88），所以按
   * 期望流量 / 稳定流量 的比例连跑若干子步，让水的整体运动速度不随弹性系数变慢。
   * 水源每步只注入一次，与子步数无关。
   */
  step(): void {
    // 粘稠度体现在 base 中：n 个子步、每步 base/n（≤ capped），总流量 = base，
    // 粘稠度连续生效；超过子步上限时才退化为每步 capped（整体变慢）。
    const { base, capped } = flowScales(this.params, this.relaxation);
    const n = Math.min(MAX_SUBSTEPS, Math.max(1, Math.ceil(base / capped - 1e-6)));
    const perStep = Math.min(capped, base / n);
    const every = Math.max(1, Math.floor(this.params.pressureEvery || 1));
    for (let s = 0; s < n; s++) this.substep(perStep, s === 0, s % every === 0);
    this.stepCount++;
  }

  /**
   * 单个子步：水源注入（仅首个子步）→ 第一遍：净压力 + 压力传递（规则1+3）
   * → 墙体反射 → 第二遍：边流量（规则2）→ 应用流量。
   */
  private substep(flowScale: number, inject: boolean, refreshPressure: boolean): void {
    const { w, h, mass, kind, pressure, flow, netP, netPH, still } = this;
    const { elasticity, gravity, expansion, selfBase, restDensity } = this.params;
    const k = Math.max(elasticity, 1e-6);
    const beta = Math.max(expansion, 0);
    // 弹性反馈比例 ρ = k/(k+1) ∈ (0,1)：弹性系数越大，反馈给周围的作用力比例越接近
    // 1（完全反作用 = 不可压缩极限），且永不超过——弹性是"硬度"，不是能量放大器。
    // k=1 → ρ=0.5；k→∞ → ρ→1。竖直面压力 = ρ·min(pL,pR)，水平面压力 = ρ·min(pU,pD)。
    const rho = k / (k + 1);
    // 静止密度的过渡带：从 0.5·m₀ 线性升到 m₀（低于 0.5·m₀ 完全不施压）。
    // 实测：带宽与 m₀ 成比例比固定带宽更稳（m₀=3 时水池漂移 0.17→0.062），
    // 小阈值时也不会把低端漏出力（m₀=0.2 时湿格 508→292）。
    const restHalf = 0.5 * restDensity;
    const restInv = restHalf > 0 ? 1 / restHalf : 0;
    const betaQuarter = beta / 4;

    // ---- 水源注入 ----
    if (inject) {
      for (let i = 0; i < kind.length; i++) {
        if (kind[i] === CELL_SOURCE) mass[i] += this.sourceRate;
      }
    }

    // ---- 第一遍：净压力 + 压力传递（规则1+3）----
    // refreshPressure = false 时整段跳过：压力场保持上一次解算的结果，
    // 质量照常流动（力的传播速度因此降为 1/K，作用距离不变）。
    if (refreshPressure) {
      // pressure[i*4+d] = 方向 d 上的邻居上一步推向本格的压力（跨帧持久）。
      // netP[i] = 竖直面压力（上下两面），netPH[i] = 水平面压力（左右两面），都含固有膨胀；
      // 向下的输出 = netP + m·g。
      // 推给邻居的压力另乘阻尼 damp 与静止比例（流动卸压），不影响流量的驱动力。
      const next = this.pressureNext;
      // 反馈回路增益 = ρ·damp ≤ 0.97 < 1，任意弹性系数下压力场都收敛不振荡
      const damp = FEEDBACK_DAMP;
      next.fill(0);
      for (let y = 0; y < h; y++) {
        const row = y * w;
        for (let x = 0; x < w; x++) {
          const i = row + x;
          if (kind[i] === CELL_WALL) {
            netP[i] = 0;
            netPH[i] = 0;
            continue;
          }
          const pi = i * 4;
          const m = mass[i];
          // 收到的压力全部来自压力场（邻居输出、上方自重、墙体 / 边界反射）。
          const hasMass = m > EMPTY_EPS;
          // 对冲交叉传递：竖向对冲 → 推左右；横向对冲 → 推上下。
          // 每格自身质量也算一份压力（selfBase·m·g）叠加到上方来压上——否则液面处竖向对冲为 0、压力链断开。
          // 竖直通道取对冲（min）而不是平均：下落的水团上下不平衡（pU ≫ pD），
          // 取平均会把这份自重不平衡泄漏到侧向、把水团撑开（BUG2 会回来）。
          const vert = Math.min(pressure[pi] + selfBase * gravity * m * still[i], pressure[pi + 1]);
          const horz = Math.min(pressure[pi + 2], pressure[pi + 3]);
          // 静止密度：低于 m₀ 的格不施反作用力，也不自发膨胀（固有膨胀同样按比例衰减），
          // 只保留自重——稀薄的水既不会回推、也不会把自己撑开，于是失去支撑、落回水体。
          // 用连续斜坡而不是硬阈值，避免格子在阈值两侧来回跳。
          const react =
            restDensity > 0 ? Math.min(1, Math.max(0, (m - restHalf) * restInv)) : 1;
          const intrinsic = hasMass ? m * betaQuarter * react : 0;
          netP[i] = rho * horz * react + intrinsic; // 竖直面压力（上下）
          netPH[i] = rho * vert * react + intrinsic; // 水平面压力（左右）
          // 只有含物质的格才向外施压；空格不传递压力（自由液面压力为 0）
          if (!hasMass) continue;
          // 流动卸压：正在流动的那部分液体把压力转化成了运动，不再向四周施压。
          // 静止比例 = 1 − 上一步流出量/m（只计流出，流入不计），四个方向的输出压力
          // （含向下的自重）统一乘以它。
          // 自由下落的水团整体在流动 → 几乎不施压 → 侧向无推力，不散开；
          // 静止水柱不流动 → 全部压力传下去 → 池底压力大、向两侧摊开。
          // 低通平滑：直接用 1 − 流出量/m 会形成"流动→卸压→不流→加压→流动"
          // 的逐步反馈，单格质量一步大一步小地来回跳（闪烁）。平滑后卸压随流动渐进生效。
          // 只统计流出量（流入不计）。flow 边的正方向是 左→右 / 上→下：
          // 右、下两条边 >0 表示本格流出；左、上两条边 <0 表示本格流出（取反变正）。
          let moved = 0;
          if (flow[i * 2] > 0) moved += flow[i * 2]; // 流向右邻
          if (flow[i * 2 + 1] > 0) moved += flow[i * 2 + 1]; // 流向下邻
          if (x > 0 && flow[(i - 1) * 2] < 0) moved += -flow[(i - 1) * 2]; // 流向左邻
          if (y > 0 && flow[(i - w) * 2 + 1] < 0) moved += -flow[(i - w) * 2 + 1]; // 流向上邻
          still[i] += (Math.max(0, 1 - moved / m) - still[i]) * STILL_SMOOTHING;
          const s = still[i];
          const outV = (rho * horz * react * damp + intrinsic) * s; // 竖直面输出（上、下）
          const outH = (rho * vert * react * damp + intrinsic) * s; // 水平面输出（左、右）
          const outDown = outV + gravity * m * s; // 向下再加自重
          // 直接推向四邻，不判断墙体：推进墙格的压力由下方「墙体反射」阶段原样退回。
          // 域边界外没有格子可写，视为刚性面直接弹回本格。
          if (y > 0) next[(i - w) * 4 + 1] += outV; // 上邻收到来自下方的输出
          else next[pi] += outV;
          if (y < h - 1) next[(i + w) * 4] += outDown; // 下邻收到来自上方的输出 + 自重
          else next[pi + 1] += outDown; // 底边界：连同自重一起弹回
          if (x > 0) next[(i - 1) * 4 + 3] += outH; // 左邻收到来自右方的输出
          else next[pi + 2] += outH;
          if (x < w - 1) next[(i + 1) * 4 + 2] += outH; // 右邻收到来自左方的输出
          else next[pi + 3] += outH;
        }
      }

      // ---- 墙体反射：墙格把本帧收到的全部压力原样退回给施压的邻居（法向反力）----
      // 在同一帧内完成，反弹不额外延迟一帧；墙格自身压力清零，不跨帧残留。
      // 上方液体压下来的自重已包含在 next[pi] 中，随之一并顶回。
      for (let y = 0; y < h; y++) {
        const row = y * w;
        for (let x = 0; x < w; x++) {
          const i = row + x;
          if (kind[i] !== CELL_WALL) continue;
          const pi = i * 4;
          // next[pi+d] 来自方向 d 的邻居 → 退回到该邻居朝向本格的槽位
          if (y > 0) next[(i - w) * 4 + 1] += next[pi];
          if (y < h - 1) next[(i + w) * 4] += next[pi + 1];
          if (x > 0) next[(i - 1) * 4 + 3] += next[pi + 2];
          if (x < w - 1) next[(i + 1) * 4 + 2] += next[pi + 3];
          next[pi] = next[pi + 1] = next[pi + 2] = next[pi + 3] = 0;
        }
      }
      pressure.set(next);
    }

    // ---- 第二遍：边流量（规则2）----
    // 每条边只算一次（本格的右边、下边），F = 两侧净压力之差，垂直边上方格多一份自重。
    // 墙体与域边界不可流入，对应边流量为 0。
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const i = row + x;
        let fh = 0;
        let fv = 0;
        if (kind[i] !== CELL_WALL) {
          const mi = mass[i];
          if (x < w - 1 && kind[i + 1] !== CELL_WALL) {
            fh = edgeFlow(netPH[i] - netPH[i + 1], mi, mass[i + 1], flowScale);
          }
          if (y < h - 1 && kind[i + w] !== CELL_WALL) {
            const weight = mi > EMPTY_EPS ? gravity * mi : 0;
            fv = edgeFlow(netP[i] + weight - netP[i + w], mi, mass[i + w], flowScale);
          }
        }
        flow[i * 2] = fh;
        flow[i * 2 + 1] = fv;
      }
    }

    // ---- 应用流量（总物质严格守恒）----
    // 每条边流量 ≤ 源格质量/4，四条边合计不超过本格质量，质量恒非负。
    // 处理到第 i 格时，它的左、上两条边已在前面处理过，右、下两条边在本格处理，
    // 所以本格的四条边此时都已结算完。
    for (let i = 0; i < mass.length; i++) {
      const fh = flow[i * 2];
      if (fh !== 0) {
        mass[i] -= fh;
        mass[i + 1] += fh;
      }
      const fv = flow[i * 2 + 1];
      if (fv !== 0) {
        mass[i] -= fv;
        mass[i + w] += fv;
      }
      // 浮点尘埃清理：Float32 下有 ~1e-7 级残差，吸附到 0 防止累积
      if (mass[i] < 0 && mass[i] > -1e-3) mass[i] = 0;
    }

  }

  // ------------------------------------------------------------------
  // 画刷操作
  // ------------------------------------------------------------------

  /** 以 (cx, cy) 为中心、半径 r 的圆形画刷，对每个格子调用回调 */
  forEachBrushCell(
    cx: number,
    cy: number,
    radius: number,
    fn: (i: number, x: number, y: number) => void,
  ): void {
    const r = Math.max(0.5, radius);
    const x0 = Math.max(0, Math.floor(cx - r));
    const x1 = Math.min(this.w - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r));
    const y1 = Math.min(this.h - 1, Math.ceil(cy + r));
    const r2 = r * r;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x - cx;
        const dy = y - cy;
        if (dx * dx + dy * dy <= r2) fn(y * this.w + x, x, y);
      }
    }
  }

  /** 开始新的一笔：清空"本笔已画过"的标记（按下鼠标时调用） */
  beginStroke(): void {
    this.strokeMask.fill(0);
  }

  /**
   * 画液体：每一笔里每格最多加一次 amount（默认 m₀）。
   * - 拖动时 paintLine 每移动半格盖一次章，同一格会被盖好几次；只认第一次，避免叠到 6 倍 m₀
   *   （过压水团一松开就沿四条轴喷出去，拖出十字形射线）。
   * - 已经有水的格照样能加：装不下（超过 m₀）的部分先补进画刷格和它们的四邻里没满的格
   *   （离画刷中心由近到远）；这些都满了，剩下的全加到画刷中心那一格，由压力推开。
   */
  paintLiquid(cx: number, cy: number, radius: number, amount = Math.max(this.params.restDensity, 0.1)): void {
    const { w, h, mass, kind, strokeMask } = this;
    const brush: number[] = [];
    let excess = 0;
    this.forEachBrushCell(cx, cy, radius, (i) => {
      if (kind[i] === CELL_WALL || strokeMask[i]) return;
      strokeMask[i] = 1;
      brush.push(i);
      const put = Math.max(0, Math.min(amount, amount - mass[i]));
      mass[i] += put;
      excess += amount - put;
    });
    if (excess <= 1e-9) return;
    const d2 = (i: number) => {
      const dx = (i % w) - cx;
      const dy = Math.floor(i / w) - cy;
      return dx * dx + dy * dy;
    };
    // 画刷格 + 四邻里没满的格，离画刷中心由近到远补满
    const cand = new Set<number>();
    for (const i of brush) {
      cand.add(i);
      const x = i % w;
      const y = (i - x) / w;
      if (y > 0) cand.add(i - w);
      if (y < h - 1) cand.add(i + w);
      if (x > 0) cand.add(i - 1);
      if (x < w - 1) cand.add(i + 1);
    }
    const open = [...cand].filter((j) => kind[j] !== CELL_WALL && mass[j] < amount).sort((a, b) => d2(a) - d2(b));
    for (const j of open) {
      const put = Math.min(excess, amount - mass[j]);
      mass[j] += put;
      excess -= put;
      if (excess <= 1e-9) return;
    }
    // 周围都满了：剩下的加到画刷中心（离 (cx, cy) 最近的画刷格）
    let center = brush[0];
    for (const i of brush) if (d2(i) < d2(center)) center = i;
    mass[center] += excess;
  }

  paintWall(cx: number, cy: number, radius: number): void {
    this.forEachBrushCell(cx, cy, radius, (i) => {
      this.kind[i] = CELL_WALL;
      this.mass[i] = 0;
    });
  }

  paintErase(cx: number, cy: number, radius: number): void {
    this.forEachBrushCell(cx, cy, radius, (i) => {
      this.kind[i] = CELL_FLUID;
      this.mass[i] = 0;
    });
  }

  paintSource(cx: number, cy: number, radius: number): void {
    this.forEachBrushCell(cx, cy, radius, (i) => {
      if (this.kind[i] !== CELL_WALL) this.kind[i] = CELL_SOURCE;
    });
  }

  // ------------------------------------------------------------------
  // 渲染辅助
  // ------------------------------------------------------------------

  get pixelWidth(): number {
    return this.w * this.cell;
  }

  get pixelHeight(): number {
    return this.h * this.cell;
  }
}
