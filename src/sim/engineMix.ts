/**
 * 混合版引擎（Mass-Weighted Velocity Mixing）—— 边上存速度，平流改成**质量加权混合**。
 *
 * 一维的核心就是一行：
 *   v[i] = (dm·v[i−1] + m_源·v[i]) / (dm + m_源)
 * dm 是这一步真正流进来的质量、v[i−1] 是它带来的速度、m_源 是本边迎风侧格子的质量。
 * 读法很直白：**新来的水带着自己的速度，和原有的水按质量混在一起**。
 *
 * 和 engineSimple / engineVel 的守恒动量平流（moved）相比，这个形式：
 *   - 有界：结果必然落在 v[i−1] 与 v[i] 之间，不可能过冲 —— 一阶迎风的 −v·∂v/∂x
 *     在 CFL 边缘会把速度推到区间外，闪烁就是从那里来的；
 *   - 不需要动量往返：整套算法（力、交叉项、粘性、限速）都直接在速度上运算，
 *     fhBuf / fvBuf 以及 u = P/m_e 的换算全部消失；
 *   - 交叉项不再需要"格心动量"那套取平均的补丁：竖直来的质量带的是**同一列、上一行那条
 *     水平边**的速度，直接 uh[i−w]，天然左右镜像对称；
 *   - 匀速平移是精确解：所有参与混合的速度都相等，加权平均当然还是它本身（45° 测试结构性正确）。
 *
 * 代价：总动量不再结构性守恒（混合式没有"流出项"—— 流走的水不改变留下来的水的速度）。
 * 这是用守恒换有界，实测见下方注释。
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
 * 分量各限会让斜向合速度达到 MAX_SPEED·√2，结构上允许对角比轴向快 41%，
 * 远场真空里水团因此长成方形。
 */
const MAX_SPEED = 12;

/**
 * 交叉项系数（竖直来的质量搬运水平速度，以及镜像的那一项）。
 * 混合式下它只影响权重，不影响有界性；匀速平移时无论权重多少结果都精确，
 * 所以这里不再像守恒形式那样是"形状 vs 守恒"的权衡旋钮。取 1 = 完整二维平流。
 */
const CROSS: number = 1;

/** 剪切粘性标定：k = VISC_SCALE · viscosity · dt，每步最多抹掉 VISC_K_MAX 的速度差 */
const VISC_SCALE = 12;
const VISC_K_MAX = 0.2;

/** 内聚只作用在两侧质量都 > WET 的边上（水 ↔ 水的内力，整团水合力为 0） */
const WET = 0.05;

/** 单边每步最多搬走源格质量的这个比例（四条边合计 ≤ 1 ⇒ 质量恒非负） */
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

export class FluidEngineMix extends FluidEngine {
  /** 时间步长（整体快慢；自由落体位移 ∝ (步数·dt)²） */
  timeStep = 0.01;
  /** 每个 step 内部细分的子步数（总物理时间仍是 timeStep） */
  substeps = 1;

  /** 每条边的速度（跨步保留的唯一状态量）：uh[i] 右边 i→i+1，uv[i] 下边 i→i+w */
  readonly uh: Float32Array;
  readonly uv: Float32Array;

  /** 每格压力 / 内聚压力 */
  private pressureBuf: Float32Array;
  private cohBuf: Float32Array;
  /**
   * 下一帧速度缓冲。平流要读**整幅旧速度场**（上下游邻边）：边扫边改的话，
   * 先处理过的邻居已经是新值，扫描顺序会给两种奇偶的格子不同待遇 → 棋盘花纹。
   */
  private uhNext: Float32Array;
  private uvNext: Float32Array;
  /** 质量增量缓冲：一步的流量先全部算完再统一应用（与扫描顺序无关） */
  private deltaBuf: Float32Array;
  /** 各向同性限速的缩放系数（同样先算完再应用） */
  private capH: Float32Array;
  private capV: Float32Array;

  constructor(w: number, h: number) {
    super(w, h);
    const n = w * h;
    this.uh = new Float32Array(n);
    this.uv = new Float32Array(n);
    this.pressureBuf = new Float32Array(n);
    this.cohBuf = new Float32Array(n);
    this.uhNext = new Float32Array(n);
    this.uvNext = new Float32Array(n);
    this.deltaBuf = new Float32Array(n);
    this.capH = new Float32Array(n);
    this.capV = new Float32Array(n);
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
    // 声速 CFL：dt ≤ 0.5/√(2S + g)
    const stiff = Math.max(c, cohPush, cohPull);
    const dt = Math.min(timeStep, 0.5 / Math.sqrt(2 * stiff + g + 1e-6));
    const n = w * h;
    // 速度上限：既不许超过 MAX_SPEED，也不许一步搬走超过源格 1/4 的质量
    const vCap = Math.min(MAX_SPEED, MAX_FRAC / dt);

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
        // 墙的反作用：贴墙格的上游边正往墙里冲时，加一份冲击压力 IMPACT·wallBounce·m·v²
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

    // ---- 2) 平流（质量加权混合）+ 力 → 新速度 ----
    // dmH/dmV：一条边这一步真正搬运的质量 = dt·v·m_源（与第 4 步的质量迁移**同一个公式**，
    // 所以混合权重用的就是真实流量，不会出现"质量搬了一份、速度按另一份混"的不一致。
    // 这正是 PLIC 当初失败的地方：质量按湿条带缩放、动量仍按整格。）
    const dmH = (e: number): number => {
      const ex = e % w;
      if (ex >= w - 1 || kind[e] === CELL_WALL || kind[e + 1] === CELL_WALL)
        return 0;
      const v = uh[e];
      if (v === 0) return 0;
      const ms = mass[v > 0 ? e : e + 1];
      if (ms <= 1e-9) return 0;
      const d = dt * v * ms;
      const cap = MAX_FRAC * ms;
      return d > cap ? cap : d < -cap ? -cap : d;
    };
    const dmV = (e: number): number => {
      if (e + w >= n || kind[e] === CELL_WALL || kind[e + w] === CELL_WALL)
        return 0;
      const v = uv[e];
      if (v === 0) return 0;
      const ms = mass[v > 0 ? e : e + w];
      if (ms <= 1e-9) return 0;
      const d = dt * v * ms;
      const cap = MAX_FRAC * ms;
      return d > cap ? cap : d < -cap ? -cap : d;
    };

    // 这条边是否真实存在且开通。流出只有在**接收边**存在时才扣除：
    // 否则扣掉的那份动量没有任何边接手，凭空消失（实测反对称比 0.954、且随步数漂移）。
    const openH = (e: number): boolean => {
      const ex = e % w;
      return e >= 0 && e < n && ex < w - 1 && kind[e] !== CELL_WALL && kind[e + 1] !== CELL_WALL;
    };
    const openV = (e: number): boolean =>
      e >= 0 && e + w < n && kind[e] !== CELL_WALL && kind[e + w] !== CELL_WALL;

    const uhNext = this.uhNext;
    const uvNext = this.uvNext;
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const i = row + x;
        if (kind[i] === CELL_WALL) {
          uhNext[i] = 0;
          uvNext[i] = 0;
          continue;
        }
        const mi = mass[i];

        // ========== 水平边 i → i+1 ==========
        if (x < w - 1 && kind[i + 1] !== CELL_WALL) {
          const mj = mass[i + 1];
          const me = 0.5 * (mi + mj);
          if (me <= 1e-9) {
            uhNext[i] = 0;
          } else {
            const v0 = uh[i];
            // m_源：迎风侧那一格，**减掉这一步流出去的质量** —— 留下来的那一份才是
            // 继续带着 v0 的物质。拉格朗日地看一步平移 ds = v·dt：
            //   留下 m_留 = (1−ds)·m_i，流入 dm = ds·m_j，新质量 m_新 = m_i − ds(m_i − m_j)
            // 而 m_留 + dm 恰好就是 m_新，所以 m_新 · v_混合 = (1−ds)m_i v_i + ds·m_j v_j
            // 精确等于线性插值的动量 —— 混合式在这个写法下是**守恒的**。
            // 若分母用整格 m_i（不扣流出），就比 m_新 多了流出那一份，动量会漏掉
            //   −ds(1−ds)·Δm·Δv
            // （数值验证：扣流出 ⇒ 乘积与守恒动量差 9e-16；不扣 ⇒ 纯平流 300 步多漏 1%）。
            // 顺带一提，"分别插值 m 与 v 再相乘"也差这同一项，偏差能到 2.6。
            //
            // 流出要扣在**四个方向**上（沿流向那条、以及交叉方向的上下两个面）：
            // 任何流走的质量带的都是 v0 自己。
            // 而且必须同时从 num 与 den 里扣 —— 只扣 den 会让匀速流变成
            // v·(den + 流出)/den > v，每步放大一点，实测 45° 平移 8.9 → 24.1 直接发散。
            // 写成 num = den·v0 就自动满足：den 扣掉多少，num 跟着少多少。
            //
            // 源格近乎空时分母几乎只剩 dm → 新速度直接取流入速度，这正是想要的：
            // 空区被填充时跟着来水走，而不是让一点点动量除以极小质量飞出去。
            //
            // 【分母取 m_e 而不是迎风格】上面那条 m_留 + dm = m_新 的恒等式只在
            // den = m_迎风 时**精确**成立，换成 m_e 后守恒退化成近似 —— 实测剪切漂移
            // −5.4e-4 → −6.7e-4（仍远优于 engineSimple 的 2.9e-3）。
            // 换来的是：m_e 才是这条边控制体真正的质量，于是
            //   45° 匀速平移 8.9 → **9.0/9.0**（精确）、镜像 3.3e-3 → 3.0e-3、
            //   dam 闪 0.400 → 0.385；落体各密度仍然都是 32.04。
            // 两者只在界面格上有差别（内部 m_e == m_迎风），所以代价很小。
            let den = me;
            {
              const o = dmH(i); // 沿流向的流出：接收边是顺流那一侧的平行边
              if (o > 0 ? openH(i + 1) : o < 0 ? x > 0 && openH(i - 1) : false)
                den -= Math.abs(o);
            }
            // --- 交叉项：竖直流动搬运水平速度 ---
            // 本边的控制体横跨 i 与 i+1 各半格，上下两个面的竖直流量取两侧竖直边的平均
            // （对 x 镜像不变，所以左右对称是结构性的）。流入带来的是同一列、相邻行那条
            // 水平边的速度 uh[i∓w] —— 不必像守恒形式那样拼"格心动量"。
            const dT = y > 0 ? 0.5 * (dmV(i - w) + dmV(i + 1 - w)) * CROSS : 0;
            const dB = y < h - 1 ? 0.5 * (dmV(i) + dmV(i + 1)) * CROSS : 0;
            // 上面那个面：dT > 0 从上方流入（带 uh[i−w]），dT < 0 往上流出（带 v0）
            if (dT < 0 && openH(i - w)) den += dT;
            // 下面那个面：dB < 0 从下方流入（带 uh[i+w]），dB > 0 往下流出（带 v0）
            if (dB > 0 && openH(i + w)) den -= dB;
            if (den < 0) den = 0;
            let num = den * v0;
            // --- 沿 x 的平流：上游那条平行边流进来的质量，带着它自己的速度 ---
            const dL = dmH(i - 1);
            if (dL > 0 && x > 0) {
              num += dL * uh[i - 1];
              den += dL;
            }
            const dR = dmH(i + 1);
            if (dR < 0) {
              num += -dR * uh[i + 1];
              den += -dR;
            }
            // 交叉方向的流入（与上面的流出两支互补，四种符号组合都已覆盖）
            if (dT > 0) {
              num += dT * uh[i - w];
              den += dT;
            }
            if (dB < 0) {
              num += -dB * uh[i + w];
              den += -dB;
            }
            let v = den > 1e-9 ? num / den : 0;
            // --- 力 → 加速度：a = F / m_边（压差是面上的量，除以面两侧的平均质量）---
            // 源格必须有水：F > 0 把 i 推向 j（源格 i），F < 0 把 j 拉回 i（源格 j）；
            // 拉一个空格时拉不出水，水也就不会被粘在空气上。
            const coh = mi > WET && mj > WET ? q[i] - q[i + 1] : 0;
            const F = p[i] - p[i + 1] + coh;
            if (F > 0 ? mi > 1e-9 : F < 0 ? mj > 1e-9 : false)
              v += (F / me) * dt;
            uhNext[i] = v > vCap ? vCap : v < -vCap ? -vCap : v;
          }
        } else {
          uhNext[i] = 0; // 墙 / 越界：法向速度为 0，也不搬质量
        }

        // ========== 竖直边 i → i+w（水平的镜像）==========
        if (y < h - 1 && kind[i + w] !== CELL_WALL) {
          const mj = mass[i + w];
          const me = 0.5 * (mi + mj);
          if (me <= 1e-9) {
            uvNext[i] = 0;
          } else {
            const v0 = uv[i];
            // 同上：边质量扣掉四个方向的流出（见水平块的推导，含分母取 m_e 的理由）
            let den = me;
            {
              const o = dmV(i);
              if (o > 0 ? openV(i + w) : o < 0 ? y > 0 && openV(i - w) : false)
                den -= Math.abs(o);
            }
            const dLf = x > 0 ? 0.5 * (dmH(i - 1) + dmH(i + w - 1)) * CROSS : 0;
            const dRt = x < w - 1 ? 0.5 * (dmH(i) + dmH(i + w)) * CROSS : 0;
            if (dLf < 0 && openV(i - 1)) den += dLf;
            if (dRt > 0 && openV(i + 1)) den -= dRt;
            if (den < 0) den = 0;
            let num = den * v0;
            const dU = dmV(i - w);
            if (dU > 0 && y > 0) {
              num += dU * uv[i - w];
              den += dU;
            }
            const dD = dmV(i + w);
            if (dD < 0) {
              num += -dD * uv[i + w];
              den += -dD;
            }
            if (dLf > 0) {
              num += dLf * uv[i - 1];
              den += dLf;
            }
            if (dRt < 0) {
              num += -dRt * uv[i + 1];
              den += -dRt;
            }
            let v = den > 1e-9 ? num / den : 0;
            const coh = mi > WET && mj > WET ? q[i] - q[i + w] : 0;
            const F = p[i] - p[i + w] + coh;
            if (F > 0 ? mi > 1e-9 : F < 0 ? mj > 1e-9 : false)
              v += (F / me) * dt;
            // 重力是**加速度**，不含质量：两条边都加 g·dt，水团整体平移、不会被拉长。
            // （守恒形式里重力是 g·m_i 的冲量，除以 m_边 后满格紧邻空格处会变成 2g，
            //  上下两条边一个 2g 一个 0 —— 质心加速度仍是 g，但水团每步被拉伸一点，
            //  这就是下落水团拖尾的来源之一。）
            v += g * dt;
            uvNext[i] = v > vCap ? vCap : v < -vCap ? -vCap : v;
          }
        } else {
          uvNext[i] = 0;
        }
      }
    }

    // ---- 2.5) 各向同性限速：按**合速度**缩放（分量各限会让斜向快 √2 倍 → 方形水团）----
    // 必须先把缩放系数全部算完、再统一应用：原地改会让后扫到的边读到已缩放的邻边值。
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
            const vA = y > 0 ? 0.5 * (uvNext[i - w] + uvNext[i]) : uvNext[i];
            const vB =
              y > 0
                ? 0.5 * (uvNext[i + 1 - w] + uvNext[i + 1])
                : uvNext[i + 1];
            const sp = Math.hypot(uhNext[i], 0.5 * (vA + vB));
            if (sp > MAX_SPEED) sh[i] = MAX_SPEED / sp;
          }
          if (y < h - 1 && kind[i + w] !== CELL_WALL) {
            const uA = x > 0 ? 0.5 * (uhNext[i - 1] + uhNext[i]) : uhNext[i];
            const uB =
              x > 0
                ? 0.5 * (uhNext[i + w - 1] + uhNext[i + w])
                : uhNext[i + w];
            const sp = Math.hypot(0.5 * (uA + uB), uvNext[i]);
            if (sp > MAX_SPEED) sv[i] = MAX_SPEED / sp;
          }
        }
      }
      for (let i = 0; i < n; i++) {
        if (sh[i] !== 1) uhNext[i] *= sh[i];
        if (sv[i] !== 1) uvNext[i] *= sv[i];
      }
    }
    uh.set(uhNext);
    uv.set(uvNext);

    // ---- 3) 剪切粘性：相邻平行边之间按速度差交换动量 ----
    this.applyViscosity(viscosity, dt, vCap);

    // ---- 4) 质量迁移：dm = v · m_源 · dt（与第 2 步混合权重用的是同一个 dmH/dmV 公式）----
    const delta = this.deltaBuf;
    delta.fill(0);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const i = row + x;
        if (kind[i] === CELL_WALL) continue;
        const a = uh[i];
        if (a !== 0 && x < w - 1 && kind[i + 1] !== CELL_WALL) {
          const ms = mass[a > 0 ? i : i + 1];
          if (ms > 1e-9) {
            let dm = dt * a * ms;
            const cap = MAX_FRAC * ms;
            if (dm > cap) dm = cap;
            else if (dm < -cap) dm = -cap;
            delta[i] -= dm;
            delta[i + 1] += dm;
          }
        }
        const b = uv[i];
        if (b !== 0 && y < h - 1 && kind[i + w] !== CELL_WALL) {
          const ms = mass[b > 0 ? i : i + w];
          if (ms > 1e-9) {
            let dm = dt * b * ms;
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
   * 剪切粘性：每一对相邻的平行边（侧向一对、顺流一对）交换动量
   *   J = k · m_共 · (v_a − v_b)，k = VISC_SCALE · viscosity · dt，m_共 = 两边质量的较小者。
   * 交换的是动量，所以各自除以自己的边质量回到速度 —— 总动量守恒，整体平动不受影响。
   * 墙当作"速度 0、质量无穷大"的水：贴墙的平行邻边吸收 kw·v（kw = k·(1 − 反弹)）。
   */
  private applyViscosity(viscosity: number, dt: number, vCap: number): void {
    const { w, h, mass, kind, uh, uv } = this;
    const k = Math.min(
      VISC_SCALE * Math.min(Math.max(viscosity, 0), 0.95) * dt,
      VISC_K_MAX,
    );
    if (k <= 0) return;
    const nh = this.uhNext;
    const nv = this.uvNext;
    nh.set(uh);
    nv.set(uv);
    const em = (a: number, b: number) => 0.5 * (mass[a] + mass[b]);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const j = row + x;
        if (kind[j] === CELL_WALL) continue;
        // ---- 水平边 j → j+1 ----
        if (x < w - 1 && kind[j + 1] !== CELL_WALL) {
          const ma = em(j, j + 1);
          if (ma > 1e-6) {
            // 侧向：下一行同位置的水平边
            if (
              y < h - 1 &&
              kind[j + w] !== CELL_WALL &&
              kind[j + w + 1] !== CELL_WALL
            ) {
              const mb = em(j + w, j + w + 1);
              if (mb > 1e-6) {
                const J = k * (ma < mb ? ma : mb) * (uh[j] - uh[j + w]);
                nh[j] -= J / ma;
                nh[j + w] += J / mb;
              }
            }
            // 顺流：右边那条水平边 j+1 → j+2
            if (x < w - 2 && kind[j + 2] !== CELL_WALL) {
              const mb = em(j + 1, j + 2);
              if (mb > 1e-6) {
                const J = k * (ma < mb ? ma : mb) * (uh[j] - uh[j + 1]);
                nh[j] -= J / ma;
                nh[j + 1] += J / mb;
              }
            }
          }
        }
        // ---- 竖直边 j → j+w ----
        if (y < h - 1 && kind[j + w] !== CELL_WALL) {
          const ma = em(j, j + w);
          if (ma > 1e-6) {
            // 侧向：右一列同位置的竖直边
            if (
              x < w - 1 &&
              kind[j + 1] !== CELL_WALL &&
              kind[j + 1 + w] !== CELL_WALL
            ) {
              const mb = em(j + 1, j + 1 + w);
              if (mb > 1e-6) {
                const J = k * (ma < mb ? ma : mb) * (uv[j] - uv[j + 1]);
                nv[j] -= J / ma;
                nv[j + 1] += J / mb;
              }
            }
            // 顺流：下面那条竖直边 j+w → j+2w
            if (y < h - 2 && kind[j + 2 * w] !== CELL_WALL) {
              const mb = em(j + w, j + 2 * w);
              if (mb > 1e-6) {
                const J = k * (ma < mb ? ma : mb) * (uv[j] - uv[j + w]);
                nv[j] -= J / ma;
                nv[j + w] += J / mb;
              }
            }
          }
        }
      }
    }
    // 墙的拖拽：每个贴墙 / 越界的平行邻边吸收 kw·v
    const kw = k * (1 - Math.min(Math.max(this.params.wallBounce ?? 0, 0), 1));
    for (let y = 0; kw > 0 && y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const j = row + x;
        if (kind[j] === CELL_WALL) continue;
        if (x < w - 1 && kind[j + 1] !== CELL_WALL && uh[j] !== 0) {
          let cnt = 0;
          if (
            y === 0 ||
            kind[j - w] === CELL_WALL ||
            kind[j - w + 1] === CELL_WALL
          )
            cnt++;
          if (
            y === h - 1 ||
            kind[j + w] === CELL_WALL ||
            kind[j + w + 1] === CELL_WALL
          )
            cnt++;
          if (x === 0 || kind[j - 1] === CELL_WALL) cnt++;
          if (x + 2 >= w || kind[j + 2] === CELL_WALL) cnt++;
          if (cnt) nh[j] -= kw * cnt * uh[j];
        }
        if (y < h - 1 && kind[j + w] !== CELL_WALL && uv[j] !== 0) {
          let cnt = 0;
          if (
            x === 0 ||
            kind[j - 1] === CELL_WALL ||
            kind[j - 1 + w] === CELL_WALL
          )
            cnt++;
          if (
            x === w - 1 ||
            kind[j + 1] === CELL_WALL ||
            kind[j + 1 + w] === CELL_WALL
          )
            cnt++;
          if (y === 0 || kind[j - w] === CELL_WALL) cnt++;
          if (y + 2 >= h || kind[j + 2 * w] === CELL_WALL) cnt++;
          if (cnt) nv[j] -= kw * cnt * uv[j];
        }
      }
    }
    for (let i = 0; i < nh.length; i++) {
      const a = nh[i];
      uh[i] = a > vCap ? vCap : a < -vCap ? -vCap : a;
      const b = nv[i];
      uv[i] = b > vCap ? vCap : b < -vCap ? -vCap : b;
    }
  }
}
