/**
 * 形心追踪引擎（Blob Tracking）—— v_blob2d.py 的 TypeScript 版。
 *
 * 速度布局同 v_net2d：
 *   u[j·(W+1) + i]：格 (i−1, j) 与 (i, j) 之间竖直面上的水平速度（正 = 向右），i = 0..W
 *   v[j·W + i]    ：格 (i, j−1) 与 (i, j) 之间水平面上的竖直速度（正 = 向下），j = 0..H
 * 每个面管两侧各半格的水（m_e = 两侧格质量的平均），存速度；每步先换成动量 P = m_e·v，
 * 算完再除以**新的** m_e 换回速度。
 *
 * 修一阶迎风的数值扩散：每格多记住"水在格子里的哪一块"（geo），每步
 *   1) 把这块水（轴对齐矩形）的四条边各按所在位置的速度挪一步；
 *   2) 按重叠面积分回各格 —— 水块没真的越过格子边界，下一格就拿不到水；
 *   3) 同一格收到的几块：面积、形心、二阶矩直接相加，再拟合出新的水块；
 *   4) 每块水从哪格到哪格记成面通量，动量平流用的就是这份通量 —— 和质量的实际移动一致。
 *
 * shape：
 *   'rect'   中心 + 宽 + 高（推荐：平移、下落精确）
 *   'offset' 只存偏向 (ox, oy) ∈ [-1, 1]；水块按质量当满密度正方形
 *   'blob'   面积 + 中心；水块当正方形，但面积与质量分开记
 *   'corner' 只存一对 (x, y) ∈ [-1, 1]：水贴着哪一边、从另一边切掉多少
 *            x < 0 贴左、x > 0 贴右，宽 = 1 − |x|；y < 0 贴上、y > 0 贴下，高 = 1 − |y|
 *            (−0.5, 0) = 左半格，(−0.5, −0.5) = 左上四分之一，(0, 0) = 整格
 *            这一对恰好是水块形心相对格心偏移的 2 倍，所以由形心直接得到，不用拟合宽高
 *
 * 和 Python 原型的差别：
 *   - 支持格内墙（CELL_WALL）与水源（CELL_SOURCE）；水块碰墙被挡住；
 *   - 侧向粘性（params.viscosity）：u 只和上下的 u、v 只和左右的 v 交换；墙摩擦 wallFriction 同理；
 *   - 斜着走的水默认按 diag8 搬动量（见 diag）；
 *   - 法向粘性 params.bulkViscosity：耗掉侧向粘性管不到的压缩波，水才能静下来；
 *   - 辛欧拉：先加力、再用新速度挪水（显式欧拉会满屏棋盘格）；
 *   - 内聚 cohesion（默认 0 = 关闭）：不满的水按密度往回拉，只作用在两侧都有水的面上；
 *   - 速度按矢量长度封顶 MAX_SPEED（不按分量，否则斜着能快 √2 倍），防止近乎空的面上算出极大速度；
 *   - 画笔 / 水源 / 橡皮直接改质量时，那一格的水块重置为居中（见 geoMass）。
 */
import { FluidEngine, CELL_WALL, CELL_SOURCE } from "./engine";

export type BlobShape = "rect" | "offset" | "blob" | "corner";
export type DiagMode = "diag8" | "route";

/** 调试读数（与其它引擎同形状，SimulationCanvas 共用） */
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

/** 压力系数：c = expansion × C_SCALE（同 engineSimple） */
const C_SCALE = 100;
/** 水块的边每步最多走这么远（格）。一格四个面，1/4 保证不会被抽成负质量 */
const MAX_MOVE = 0.25;
/** 速度上限（矢量长度，格 / 单位时间） */
const MAX_SPEED = 50;
/** 侧向粘性 / 墙摩擦：k = VISC_SCALE · viscosity · dt，每对每步最多 VISC_K_MAX（不反号） */
const VISC_SCALE = 12;
const VISC_K_MAX = 0.125;
/** 水源溢出的补水范围（格），按欧氏距离由近到远 */
const SOURCE_RADIUS = 4;
const SOURCE_RING: [number, number][] = (() => {
  const r = SOURCE_RADIUS;
  const out: [number, number][] = [];
  for (let dy = -r; dy <= r; dy++)
    for (let dx = -r; dx <= r; dx++) if (dx * dx + dy * dy <= r * r) out.push([dx, dy]);
  return out.sort((a, b) => a[0] * a[0] + a[1] * a[1] - (b[0] * b[0] + b[1] * b[1]));
})();
const EPS = 1e-9;
/** acc 每格几个数 */
const ACC = 6;
/** 格质量超过它才算"有水"：内聚负压只作用在两侧都有水的面上 */
const WET = 0.05;

export class FluidEngineBlob extends FluidEngine {
  timeStep = 0.01;
  shape: BlobShape = "rect";
  /**
   * 斜着落进对角格的那一小块水，动量怎么搬：
   *   'diag8'：沿对角直接搬（8 方向平流），一步到位，动量不落后于质量（默认）
   *   'route'：记成面通量时借道一个相邻格（按中间格质量分两条路），动量在中间面上停一步
   */
  diag: DiagMode = "diag8";
  /** 墙的摩擦 0..0.95（同粘性的标定）：贴墙的面每步把一部分平行动量交给墙。0 = 光滑墙 */
  wallFriction = 0.01;
  /**
   * 内聚 k1 ≥ 0：被拉稀的水（密度 ρ < m₀）往回拉，P = max(−k1·ρ, c·(ρ − m₀))。0 = 关闭。
   * 注意：0 < ρ < ρ* 这一段 P 随 ρ 下降（越稀压力越高）—— 反扩散。没有表面张力项时
   * k1 太大会在网格尺度上抖动、水越摊越开（Python 原型：elastic 50、dt 0.01 时 k1 ≤ 5 不起振）
   */
  cohesion = 0;

  /** 面速度（跨步保留） */
  readonly u: Float64Array;
  readonly v: Float64Array;

  /**
   * 每格的水块（格内坐标，中心相对格心）：
   *   gA 面积（几何面积，与质量分开记 —— 被拉开的水面积不变、只是变稀）
   *   gX, gY 中心偏移 ∈ [−0.5, 0.5]（存偏移而不存 0..1：贴左 / 贴右两侧精度相同，镜像不被舍入打破）
   *   gW, gH 宽、高
   */
  private gA: Float64Array;
  private gX: Float64Array;
  private gY: Float64Array;
  private gW: Float64Array;
  private gH: Float64Array;
  /** 拟合水块时的质量：与当前质量不同 ⇒ 这一格被画笔 / 水源 / 橡皮改过，水块重置 */
  private geoMass: Float32Array;

  // 工作区
  private p: Float64Array;
  private Pu: Float64Array;
  private Pv: Float64Array;
  private dPu: Float64Array;
  private dPv: Float64Array;
  private Fu: Float64Array;
  private Fv: Float64Array;
  private newm: Float64Array;
  /** 每格收到的水块的矩，按**质量**加权：[Σd, Σd·ξ, Σd·η, Σd·ξ², Σd·η², Σd·ρ]（相对格心），见第 4 步 */
  private acc: Float64Array;
  private diagBuf: number[] = [];
  /** 速度封顶用的旧速度副本 */
  private capU: Float64Array;
  private capV: Float64Array;
  /** 每步预先算好：面是否开着（两侧都不是墙、不在域边界）、面质量 m_e（两侧格质量的平均） */
  private oU: Uint8Array;
  private oV: Uint8Array;
  private mU: Float64Array;
  private mV: Float64Array;
  /** 上次算 oU / oV 时的格类型：墙没变就不重算 */
  private kindSeen: Uint8Array;
  /** renderDensity 的输出 */
  private rho: Float32Array;
  /** renderBlocks 的输出：每格 [x0, x1, y0, y1] */
  private blk: Float32Array;

  constructor(w: number, h: number) {
    super(w, h);
    const n = w * h;
    this.u = new Float64Array(h * (w + 1));
    this.v = new Float64Array((h + 1) * w);
    this.gA = new Float64Array(n);
    this.gX = new Float64Array(n);
    this.gY = new Float64Array(n);
    this.gW = new Float64Array(n);
    this.gH = new Float64Array(n);
    this.geoMass = new Float32Array(n);
    this.p = new Float64Array(n);
    this.Pu = new Float64Array(h * (w + 1));
    this.Pv = new Float64Array((h + 1) * w);
    this.dPu = new Float64Array(h * (w + 1));
    this.dPv = new Float64Array((h + 1) * w);
    this.Fu = new Float64Array(h * (w + 1));
    this.Fv = new Float64Array((h + 1) * w);
    this.newm = new Float64Array(n);
    this.acc = new Float64Array(n * ACC);
    this.capU = new Float64Array(h * (w + 1));
    this.capV = new Float64Array((h + 1) * w);
    this.oU = new Uint8Array(h * (w + 1));
    this.oV = new Uint8Array((h + 1) * w);
    this.mU = new Float64Array(h * (w + 1));
    this.mV = new Float64Array((h + 1) * w);
    this.kindSeen = new Uint8Array(n).fill(255);
    this.rho = new Float32Array(n);
    this.blk = new Float32Array(n * 4);
  }

  override clear(): void {
    super.clear();
    this.u.fill(0);
    this.v.fill(0);
    this.gA.fill(0);
    this.gX.fill(0);
    this.gY.fill(0);
    this.gW.fill(0);
    this.gH.fill(0);
    this.geoMass.fill(0);
  }

  override step(): void {
    this.advance(this.timeStep);
    this.stepCount++;
  }

  /**
   * 格 (i, j) 那一行 u 的局部插值：左右两个面 a、b，s ∈ [−0.5, 0.5]。
   * 写成"中点 + 偏移 × 差"的形式：左右镜像时 s → −s、两侧面速度互换并取反，结果逐位取反。
   * 关着的面（贴墙 / 域边界）速度恒为 0。水**离开**墙时那不是水的速度 —— 用开着的那一面代替：
   * 贴着天花板的水，上面那个面恒为 0、下面那个面在下落，按两面插值时水块上沿不动、下沿往下走，
   * 被拉成一条线（实测落 300 步只落了 2.89 格、摊成 5 行；离天花板一格画就是精确的 4.50）。
   * 但只有水**没被压着**（压力 ≤ 0）、开着的那面又在往远离墙的方向走时才换：
   * 压在地面上的水，地面那条边就该不动。若也换，被压实的一格水上面那个面一往上走，整块水跟着
   * 整体往上飞 —— 水块不膨胀、密度不降、压力一直在推，越弹越高（无粘性时能量从 1 涨到 40）。
   * 两面都关着返回 NaN（这一行没有可用的速度）
   */
  private uRow(j: number, i: number, s: number): number {
    const e = j * (this.w + 1) + i, oU = this.oU, u = this.u;
    let a = u[e], b = u[e + 1];
    const oa = oU[e], ob = oU[e + 1];
    if (!oa || !ob) {
      if (!oa && !ob) return NaN;
      const free = this.p[j * this.w + i] <= 0;
      if (!oa) a = free && b > 0 ? b : 0; // 左边是墙：只有往右离开才跟着走
      else b = free && a < 0 ? a : 0; // 右边是墙：只有往左离开
    }
    return 0.5 * (a + b) + s * (b - a);
  }

  /** 格 (i, j) 那一列 v 的局部插值（同 uRow，横竖对调） */
  private vCol(j: number, i: number, t: number): number {
    const W = this.w, e = j * W + i, oV = this.oV, v = this.v;
    let a = v[e], b = v[e + W];
    const oa = oV[e], ob = oV[e + W];
    if (!oa || !ob) {
      if (!oa && !ob) return NaN;
      const free = this.p[j * W + i] <= 0;
      if (!oa) a = free && b > 0 ? b : 0; // 上面是墙（天花板）：只有往下离开才跟着走
      else b = free && a < 0 ? a : 0; // 下面是墙（地面）：只有往上离开
    }
    return 0.5 * (a + b) + t * (b - a);
  }

  /**
   * 格 (i, j) 内局部点 (s, t)（相对格心，−0.5..0.5）处的水平速度：本行按 uRow，
   * 再往 t 那一侧的相邻行插一点（那一行没有可用的速度 —— 墙格 —— 就不插）
   */
  private uLocal(i: number, j: number, s: number, t: number): number {
    const val = this.uRow(j, i, s);
    if (val !== val) return 0; // 两面都关着：水块左右都是墙，横向不动
    if (t > 0 && j + 1 < this.h) {
      const nb = this.uRow(j + 1, i, s);
      if (nb === nb) return val + t * (nb - val);
    } else if (t < 0 && j > 0) {
      const nb = this.uRow(j - 1, i, s);
      if (nb === nb) return val + -t * (nb - val);
    }
    return val;
  }

  /** 格 (i, j) 内局部点 (s, t) 处的竖直速度（同 uLocal，横竖对调） */
  private vLocal(i: number, j: number, s: number, t: number): number {
    const val = this.vCol(j, i, t);
    if (val !== val) return 0;
    if (s > 0 && i + 1 < this.w) {
      const nb = this.vCol(j, i + 1, t);
      if (nb === nb) return val + s * (nb - val);
    } else if (s < 0 && i > 0) {
      const nb = this.vCol(j, i - 1, t);
      if (nb === nb) return val + -s * (nb - val);
    }
    return val;
  }

  /** 由矩拟合水块，写回第 c 格 */
  private fit(c: number, A: number, Ax: number, Ay: number, Axx: number, Ayy: number): void {
    const ex = Ax / A, ey = Ay / A;
    if (this.shape === "corner") {
      // 贴边的矩形：贴左时 x ∈ [−0.5, −0.5 + w]，形心 −0.5 + w/2 ⇒ x = −(1 − w) = 2·形心；贴右同理
      const x = Math.max(-1, Math.min(1, 2 * ex));
      const y = Math.max(-1, Math.min(1, 2 * ey));
      this.gX[c] = x;
      this.gY[c] = y;
      this.gW[c] = 1 - Math.abs(x);
      this.gH[c] = 1 - Math.abs(y);
      this.gA[c] = this.gW[c] * this.gH[c];
      return;
    }
    if (this.shape === "offset") {
      // 只记偏向；面积、宽高在搬运时按质量重算
      this.gA[c] = A;
      this.gX[c] = ex;
      this.gY[c] = ey;
      this.gW[c] = 0;
      this.gH[c] = 0;
      return;
    }
    const a = Math.min(A, 1);
    let w: number, h: number;
    if (this.shape === "rect") {
      const vx = Math.max(Axx / A - ex * ex, 1e-12);
      const vy = Math.max(Ayy / A - ey * ey, 1e-12);
      const r = Math.sqrt(vx / vy); // 宽 / 高 = 两个方向标准差之比
      w = Math.sqrt(a * r);
      h = Math.sqrt(a / r);
      if (w > 1) {
        w = 1;
        h = Math.min(1, a);
      }
      if (h > 1) {
        h = 1;
        w = Math.min(1, a);
      }
    } else {
      w = h = Math.sqrt(a);
    }
    const lx = (1 - w) / 2, ly = (1 - h) / 2;
    this.gA[c] = a;
    this.gX[c] = Math.max(-lx, Math.min(lx, ex));
    this.gY[c] = Math.max(-ly, Math.min(ly, ey));
    this.gW[c] = w;
    this.gH[c] = h;
  }

  /** 第 c 格那块水的密度 = 质量 / 水块面积（与搬运时重建水块的方式一致） */
  private density(c: number, m: number, m0: number): number {
    let A: number;
    if (this.shape === "corner") A = (1 - Math.abs(this.gX[c])) * (1 - Math.abs(this.gY[c]));
    else if (this.shape === "offset") A = Math.min(1, m / m0); // offset 假设水块总是满密度
    else A = this.gA[c];
    return A > 1e-12 ? m / A : m;
  }

  /** 第 c 格的质量被外部改过：水块重置为居中、按满密度的面积 */
  private resetGeo(c: number, m0: number): void {
    const m = this.mass[c];
    const a = m <= 0 ? 0 : m0 > 0 ? Math.min(1, m / m0) : 1;
    const s = this.shape === "corner" ? 1 : Math.sqrt(a); // corner：(0, 0) = 整格
    this.gA[c] = this.shape === "corner" ? (m > 0 ? 1 : 0) : a;
    this.gX[c] = 0;
    this.gY[c] = 0;
    this.gW[c] = s;
    this.gH[c] = s;
    this.geoMass[c] = m;
  }

  private advance(timeStep: number): void {
    const W = this.w, H = this.h, n = W * H, UW = W + 1;
    const { mass, kind, u, v } = this;
    const { gravity, expansion, restDensity, viscosity, bulkViscosity } = this.params;
    const c = Math.max(expansion, 0) * C_SCALE;
    const g = Math.max(gravity, 0);
    const m0 = Math.max(restDensity, 0);
    // 声速 CFL：dt ≤ 0.5/√(2c + g)
    const dt = Math.min(timeStep, 0.5 / Math.sqrt(2 * c + g + 1e-6));
    const vCap = Math.min(MAX_SPEED, MAX_MOVE / dt);
    // 面的开闭、面质量：每步查表，不在每个循环里调闭包、重算 0.5·(m + m)（结果逐位相同）
    const { oU, oV, mU, mV, kindSeen } = this;
    let kindChanged = false;
    for (let k = 0; k < n; k++)
      if (kind[k] !== kindSeen[k]) {
        kindChanged = true;
        break;
      }
    if (kindChanged) {
      kindSeen.set(kind);
      for (let j = 0; j < H; j++)
        for (let i = 0; i <= W; i++)
          oU[j * UW + i] = i > 0 && i < W && kind[j * W + i - 1] !== CELL_WALL && kind[j * W + i] !== CELL_WALL ? 1 : 0;
      for (let j = 0; j <= H; j++)
        for (let i = 0; i < W; i++)
          oV[j * W + i] = j > 0 && j < H && kind[(j - 1) * W + i] !== CELL_WALL && kind[j * W + i] !== CELL_WALL ? 1 : 0;
    }
    const faceMass = () => {
      for (let j = 0; j < H; j++)
        for (let i = 0; i <= W; i++) {
          const e = j * UW + i;
          mU[e] = oU[e] ? 0.5 * (mass[j * W + i - 1] + mass[j * W + i]) : 0;
        }
      for (let j = 0; j <= H; j++)
        for (let i = 0; i < W; i++) {
          const e = j * W + i;
          mV[e] = oV[e] ? 0.5 * (mass[(j - 1) * W + i] + mass[j * W + i]) : 0;
        }
    };
    // 速度封顶：按**矢量长度** |(u, v̄)| 封，不按分量。按分量封时斜着走的水能到 √2·vCap
    // （两个分量各顶到 vCap）：高压的水一炸开，沿轴被封在 vCap、沿对角跑到 1.41 倍 —— 摊成方形 / X。
    // 每个面用旧速度算：u 面上的 v 取周围四个 v 面的平均，v 面上的 u 同理
    const vCap2 = vCap * vCap;
    const capVel = () => {
      // 先看最大分量：max|u|² + max|v|² ≤ vCap² 时没有哪个面会超，直接跳过（绝大多数步）
      let mu = 0, mv = 0;
      for (let q = 0; q < u.length; q++) { const x = Math.abs(u[q]); if (x > mu) mu = x; }
      for (let q = 0; q < v.length; q++) { const x = Math.abs(v[q]); if (x > mv) mv = x; }
      if (mu * mu + mv * mv <= vCap2) return;
      const cu = this.capU, cv = this.capV;
      cu.set(u);
      cv.set(v);
      for (let j = 0; j < H; j++)
        for (let i = 1; i < W; i++) {
          const e = j * UW + i;
          const a = cu[e];
          const b = 0.25 * (cv[j * W + i - 1] + cv[j * W + i] + cv[(j + 1) * W + i - 1] + cv[(j + 1) * W + i]);
          const s2 = a * a + b * b;
          if (s2 > vCap2) u[e] = a * (vCap / Math.sqrt(s2));
        }
      for (let j = 1; j < H; j++)
        for (let i = 0; i < W; i++) {
          const e = j * W + i;
          const b = cv[e];
          const a = 0.25 * (cu[(j - 1) * UW + i] + cu[(j - 1) * UW + i + 1] + cu[j * UW + i] + cu[j * UW + i + 1]);
          const s2 = a * a + b * b;
          if (s2 > vCap2) v[e] = b * (vCap / Math.sqrt(s2));
        }
    };

    // ---- 水源注入：先灌满水源格，溢出由近到远补进周围没满的格 ----
    for (let k = 0; k < n; k++) {
      if (kind[k] !== CELL_SOURCE) continue;
      let add = this.sourceRate * dt;
      if (m0 <= 0) {
        mass[k] += add;
        continue;
      }
      const sx = k % W, sy = (k - sx) / W;
      for (let r = 0; r < SOURCE_RING.length && add > 1e-9; r++) {
        const x = sx + SOURCE_RING[r][0], y = sy + SOURCE_RING[r][1];
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const q = y * W + x;
        if (kind[q] === CELL_WALL || mass[q] >= m0) continue;
        const put = Math.min(add, m0 - mass[q]);
        mass[q] += put;
        add -= put;
      }
      if (add > 0) mass[k] += add;
    }

    // ---- 被外部改过质量的格（画笔 / 水源 / 橡皮）：动量守恒，水块重置 ----
    // 面上存的是速度。加进来的水是静止的，面的动量不该变：v ← v · m_旧 / m_新。
    // 不这样的话，一个只剩一点水（面质量 0.2）却已经落得很快的面，画满之后整格水都按那个速度
    // 往下冲 —— 在下落的水走过的路上画水，比别处落得快得多。只在面质量变大时缩，变小（橡皮）时速度不变
    const geoMass = this.geoMass;
    let changed = false;
    for (let k = 0; k < n; k++)
      if (mass[k] !== geoMass[k]) {
        changed = true;
        break;
      }
    if (changed) {
      for (let j = 0; j < H; j++)
        for (let i = 1; i < W; i++) {
          const a = j * W + i - 1, b = a + 1;
          if (mass[a] === geoMass[a] && mass[b] === geoMass[b]) continue;
          const mOld = geoMass[a] + geoMass[b], mNew = mass[a] + mass[b];
          if (mOld > 0 && mNew > mOld) u[j * UW + i] *= mOld / mNew;
        }
      for (let j = 1; j < H; j++)
        for (let i = 0; i < W; i++) {
          const a = (j - 1) * W + i, b = a + W;
          if (mass[a] === geoMass[a] && mass[b] === geoMass[b]) continue;
          const mOld = geoMass[a] + geoMass[b], mNew = mass[a] + mass[b];
          if (mOld > 0 && mNew > mOld) v[j * W + i] *= mOld / mNew;
        }
      for (let k = 0; k < n; k++) if (mass[k] !== geoMass[k]) this.resetGeo(k, m0);
    }
    faceMass();

    // ---- 压力（k2 = c，k1 = cohesion）----
    //   压实（ρ > m₀）：P = k2·(m − m₀·A) = k2·m·(1 − m₀/ρ) —— 水块面积 A 装不下的那部分才推；
    //     满格且水块撑满（A = 1）时就是 k2·(m − m₀)。不满的格也用这一条：一格高压的水挤进四个邻格后
    //     是四条很密的薄条，压力若按 0 算，推不动旁边、只能沿原方向一直飞 —— 摊成十字。
    //     满格也要看 A：贴地的一层满格水被重力压扁（A < 1）却算 k2·(m − m₀) = 0，没有东西托住它，
    //     水面那个面的速度一直涨到封顶。乘上 m 是因为面质量 ≈ m/2：加速度 ≤ 2·k2·(1 − m₀/ρ)，不随 1/m 爆掉
    //   稀（ρ ≤ m₀）：P = min(0, max(−k1·ρ, k2·(ρ − m₀)))，ρ = 水块密度（质量 / 水块面积）
    //     两条直线交于 ρ* = k2·m₀/(k1 + k2)，P* = −k1·k2·m₀/(k1 + k2)；ρ → m₀ 时 P → 0，与压实那一段连续。
    //   不满时看**密度**不看质量：一块满密度的水正在跨过格子边界，下一格只分到一薄条（质量小、密度 1），
    //   按质量算会把它当成稀水往回拉，下落的水被拽住。
    const p = this.p;
    const k1 = Math.max(this.cohesion, 0);
    for (let k = 0; k < n; k++) {
      const m = mass[k];
      if (kind[k] === CELL_WALL || m <= 0) p[k] = 0;
      else if (m0 <= 0) p[k] = c * m;
      else {
        const r = this.density(k, m, m0);
        if (r > m0) p[k] = c * m * (1 - m0 / r);
        else if (k1 <= 0) p[k] = 0;
        else p[k] = Math.min(0, Math.max(-k1 * r, c * (r - m0)));
      }
    }
    // 负压（内聚）只在两侧都有水的面上起作用：它是水与水之间的拉力。
    // 对着空格的那一面若也算负压，等于被真空吸住 —— 一团悬空的薄水会被吸在原地掉不下来
    const faceDp = (a: number, b: number) =>
      mass[a] > WET && mass[b] > WET ? p[a] - p[b] : Math.max(p[a], 0) - Math.max(p[b], 0);

    // ---- 0) 速度 → 动量；1) 力；1.5) 辛欧拉 ----
    // 辛欧拉：力先加进速度，再用**新**速度挪水、平流动量。
    // 顺序是 压力(m_n) → 速度(v_n+1) → 质量(用 v_n+1) → 下一步压力(m_n+1) ……
    // 显式欧拉（用旧速度挪水）每步把压力 ↔ 质量这个振子的能量放大，网格尺度的波最先失稳 ——
    // 满屏棋盘格；硬的水（c 大）、大 dt 时整个溃坝都会越晃越厉害。辛欧拉下振子能量不涨。
    // 三件事在一趟里做完：P = m_e·v，P += 力·dt，v = P/m_e；dP 清零留给平流 / 粘性
    const { Pu, Pv, dPu, dPv } = this;
    for (let j = 0; j < H; j++)
      for (let i = 0; i <= W; i++) {
        const e = j * UW + i;
        dPu[e] = 0;
        if (oU[e]) {
          const me = mU[e];
          const P = me * u[e] + faceDp(j * W + i - 1, j * W + i) * dt;
          Pu[e] = P;
          u[e] = me > EPS ? P / me : 0;
        } else Pu[e] = 0;
      }
    for (let j = 0; j <= H; j++)
      for (let i = 0; i < W; i++) {
        const e = j * W + i;
        dPv[e] = 0;
        if (oV[e]) {
          const me = mV[e];
          const P = me * v[e] + (me * g + faceDp((j - 1) * W + i, j * W + i)) * dt;
          Pv[e] = P;
          v[e] = me > EPS ? P / me : 0;
        } else Pv[e] = 0;
      }
    capVel();

    // ---- 2) 质量：挪水块、按重叠面积分格 ----
    const { Fu, Fv, newm, acc } = this;
    Fu.fill(0);
    Fv.fill(0);
    newm.fill(0);
    acc.fill(0);
    const clampMove = (d: number) => (d > MAX_MOVE ? MAX_MOVE : d < -MAX_MOVE ? -MAX_MOVE : d);
    const diag8 = this.diag === "diag8";
    // 斜着落进对角格的每一小块：(i, j, k, l, d) 依次排开（只有 diag8 用）
    const D = this.diagBuf;
    D.length = 0;
    // 循环里要用的字段先取成局部变量（每格都读 this.xxx、比较 shape 字符串，占了这一段一半的时间）
    const { gA, gX, gY, gW, gH } = this;
    const isCorner = this.shape === "corner", isOffset = this.shape === "offset";
    const addU = (row: number, a: number, b: number, d: number) => {
      if (b === a + 1) Fu[row * UW + b] += d;
      else Fu[row * UW + a] -= d;
    };
    const addV = (col: number, a: number, b: number, d: number) => {
      if (b === a + 1) Fv[b * W + col] += d;
      else Fv[a * W + col] -= d;
    };
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        const src = j * W + i;
        const m = mass[src];
        if (m <= 0 || kind[src] === CELL_WALL) continue;
        let A = gA[src], ex = gX[src], ey = gY[src], bw = gW[src], bh = gH[src];
        if (isCorner) {
          // (x, y) → 贴边矩形：宽 1 − |x|，中心偏移 x/2（左半格 x = −0.5 ⇒ 中心 −0.25）
          bw = 1 - Math.abs(ex);
          bh = 1 - Math.abs(ey);
          ex = ex / 2;
          ey = ey / 2;
          A = bw * bh;
        } else if (isOffset) {
          A = m0 > 0 ? Math.min(1, m / m0) : 1;
          bw = bh = Math.sqrt(A);
          // 偏向 ∈ [-1, 1] ↔ 中心偏移可动范围 [−(1−w)/2, (1−w)/2]
          let ox = bw >= 1 ? 0 : ex / ((1 - bw) / 2);
          let oy = bh >= 1 ? 0 : ey / ((1 - bh) / 2);
          ox = Math.max(-1, Math.min(1, ox));
          oy = Math.max(-1, Math.min(1, oy));
          ex = (ox * (1 - bw)) / 2;
          ey = (oy * (1 - bh)) / 2;
        }
        // 所有位置都相对**格心**算（−0.5..0.5），不用全局坐标：全局坐标的舍入随格号变，
        // 左右镜像的两块水从第 1 步起就差 1e-15，之后被流动放大成肉眼可见的不对称
        let a0: number, a1: number, b0: number, b1: number;
        if (m0 <= 0 || m >= m0 || A >= 1 - 1e-9) {
          a0 = -0.5; a1 = 0.5; b0 = -0.5; b1 = 0.5; // 满格：整格都是水
        } else {
          a0 = ex - bw / 2; a1 = ex + bw / 2;
          b0 = ey - bh / 2; b1 = ey + bh / 2;
        }
        const ac = (a0 + a1) / 2, bc = (b0 + b1) / 2;
        let na0 = a0 + clampMove(this.uLocal(i, j, a0, bc) * dt);
        let na1 = a1 + clampMove(this.uLocal(i, j, a1, bc) * dt);
        let nb0 = b0 + clampMove(this.vLocal(i, j, ac, b0) * dt);
        let nb1 = b1 + clampMove(this.vLocal(i, j, ac, b1) * dt);
        // 墙 / 域边界挡住（每步最多走 1/4 格，所以只可能碰到紧邻的格）。两端都夹，
        // 否则一端被墙挡住、另一端还在往墙里走，水块会翻过来（宽度为负）
        const loX = i === 0 || kind[src - 1] === CELL_WALL ? -0.5 : -1.5;
        const hiX = i === W - 1 || kind[src + 1] === CELL_WALL ? 0.5 : 1.5;
        const loY = j === 0 || kind[src - W] === CELL_WALL ? -0.5 : -1.5;
        const hiY = j === H - 1 || kind[src + W] === CELL_WALL ? 0.5 : 1.5;
        na0 = Math.min(Math.max(na0, loX), hiX);
        na1 = Math.min(Math.max(na1, loX), hiX);
        nb0 = Math.min(Math.max(nb0, loY), hiY);
        nb1 = Math.min(Math.max(nb1, loY), hiY);
        // 被压成一条线：给它一个极小的宽度，但不能伸出墙外 ——
        // 以墙线为中心展开的话，一半落进墙里，那份质量就丢了
        if (na1 - na0 < 1e-9) {
          const cc = Math.min(Math.max((na0 + na1) / 2, loX + 5e-10), hiX - 5e-10);
          na0 = cc - 5e-10; na1 = cc + 5e-10;
        }
        if (nb1 - nb0 < 1e-9) {
          const cc = Math.min(Math.max((nb0 + nb1) / 2, loY + 5e-10), hiY - 5e-10);
          nb0 = cc - 5e-10; nb1 = cc + 5e-10;
        }
        // 落进哪几格：相对坐标下格 i + dk 占 [dk − 0.5, dk + 0.5]
        const dk0 = Math.max(Math.floor(na0 + 0.5), -i), dk1 = Math.min(Math.floor(na1 + 0.5), W - 1 - i);
        const dl0 = Math.max(Math.floor(nb0 + 0.5), -j), dl1 = Math.min(Math.floor(nb1 + 0.5), H - 1 - j);
        // 斜对角那一格若是墙：那一块不要，密度按剩下的面积重算（质量照样守恒）
        let aOk = 0;
        for (let dl = dl0; dl <= dl1; dl++) {
          const q0 = Math.max(nb0, dl - 0.5), q1 = Math.min(nb1, dl + 0.5);
          if (q1 <= q0) continue;
          for (let dk = dk0; dk <= dk1; dk++) {
            if (kind[(j + dl) * W + i + dk] === CELL_WALL) continue;
            const p0 = Math.max(na0, dk - 0.5), p1 = Math.min(na1, dk + 0.5);
            if (p1 > p0) aOk += (p1 - p0) * (q1 - q0);
          }
        }
        if (aOk <= 0) {
          // 极端情况：整块都落到了墙格里 —— 原地不动
          newm[src] += m;
          const r0 = m / ((a1 - a0) * (b1 - b0));
          const o = src * ACC;
          acc[o] += m;
          acc[o + 1] += (m * (a0 + a1)) / 2;
          acc[o + 2] += (m * (b0 + b1)) / 2;
          acc[o + 3] += (m * (a0 * a0 + a1 * a1 + a0 * a1)) / 3;
          acc[o + 4] += (m * (b0 * b0 + b1 * b1 + b0 * b1)) / 3;
          acc[o + 5] += m * r0;
          continue;
        }
        const rho = m / aOk;
        for (let dl = dl0; dl <= dl1; dl++) {
          const q0 = Math.max(nb0, dl - 0.5), q1 = Math.min(nb1, dl + 0.5);
          if (q1 <= q0) continue;
          const l = j + dl;
          for (let dk = dk0; dk <= dk1; dk++) {
            const k = i + dk;
            const dst = l * W + k;
            if (kind[dst] === CELL_WALL) continue;
            const p0 = Math.max(na0, dk - 0.5), p1 = Math.min(na1, dk + 0.5);
            if (p1 <= p0) continue;
            const a = (p1 - p0) * (q1 - q0);
            const d = rho * a;
            newm[dst] += d;
            // 落进格 k 后，相对**它自己**格心的坐标；二阶矩写成对两端对称的形式（镜像时逐位相同）
            const lx0 = p0 - dk, lx1 = p1 - dk, ly0 = q0 - dl, ly1 = q1 - dl;
            const o = dst * ACC;
            acc[o] += d;
            acc[o + 1] += (d * (lx0 + lx1)) / 2;
            acc[o + 2] += (d * (ly0 + ly1)) / 2;
            acc[o + 3] += (d * (lx0 * lx0 + lx1 * lx1 + lx0 * lx1)) / 3;
            acc[o + 4] += (d * (ly0 * ly0 + ly1 * ly1 + ly0 * ly1)) / 3;
            acc[o + 5] += d * rho;
            // 面通量：这份水从 (i, j) 走到了 (k, l)
            if (dk !== 0 && dl !== 0) {
              if (diag8) {
                // diag8：不记成面通量，动量在第 3 步沿对角直接搬
                D.push(i, j, k, l, d);
                continue;
              }
              // route：斜着走借道一个相邻格。两条路按**中间格的质量**分配：前沿处中间格
              // 往往几乎是空的，平分会把一半动量放到一个空面上，除以 ~0 的面质量后速度被放大
              const ma = mass[j * W + k] + 1e-12; // 先横后竖：经过 (k, j)
              const mb = mass[l * W + i] + 1e-12; // 先竖后横：经过 (i, l)
              const ra = ma / (ma + mb);
              addU(j, i, k, d * ra);
              addV(k, j, l, d * ra);
              addV(i, j, l, d * (1 - ra));
              addU(l, i, k, d * (1 - ra));
            } else if (dk !== 0) addU(j, i, k, d);
            else if (dl !== 0) addV(i, j, l, d);
          }
        }
      }
    }

    // ---- 3) 动量平流：每处只做一次迎风搬运，通量用上面记下的真实通量 ----
    // 迎风搬运用的是"来的那一面"的速度。来的那面关着（贴墙）时它存的 0 不是水的速度 ——
    // 贴着天花板往下落的水，上半格那份动量本来就没地方存，按 0 搬进来，整格水就比 g 落得慢
    // （实测落到 0.6 时速度 0.535，精确 0.6）。这时用去的那一面的速度：离开墙的水和整格水一起动。
    // 流向墙的那份（fc 指向关着的面）照旧被墙吃掉 —— 墙不回弹
    const donorU = (from: number, to: number) => (oU[from] ? u[from] : u[to]);
    const donorV = (from: number, to: number) => (oV[from] ? v[from] : v[to]);
    // u 沿 x：经过格心
    for (let j = 0; j < H; j++)
      for (let cc = 0; cc < W; cc++) {
        const a = j * UW + cc;
        const fc = 0.5 * (Fu[a] + Fu[a + 1]);
        if (fc > 0) {
          const t = fc * donorU(a, a + 1);
          dPu[a] -= t;
          dPu[a + 1] += t;
        } else if (fc < 0) {
          const t = -fc * donorU(a + 1, a);
          dPu[a + 1] -= t;
          dPu[a] += t;
        }
      }
    // u 沿 y：经过格角，流过的质量 = 两侧竖直通量的平均
    for (let j = 1; j < H; j++)
      for (let i = 1; i < W; i++) {
        const fc = 0.5 * (Fv[j * W + i - 1] + Fv[j * W + i]);
        const up = (j - 1) * UW + i, dn = j * UW + i;
        if (fc > 0) {
          const t = fc * donorU(up, dn);
          dPu[up] -= t;
          dPu[dn] += t;
        } else if (fc < 0) {
          const t = -fc * donorU(dn, up);
          dPu[dn] -= t;
          dPu[up] += t;
        }
      }
    // v 沿 y：经过格心
    for (let cc = 0; cc < H; cc++)
      for (let i = 0; i < W; i++) {
        const a = cc * W + i, b = (cc + 1) * W + i;
        const fc = 0.5 * (Fv[a] + Fv[b]);
        if (fc > 0) {
          const t = fc * donorV(a, b);
          dPv[a] -= t;
          dPv[b] += t;
        } else if (fc < 0) {
          const t = -fc * donorV(b, a);
          dPv[b] -= t;
          dPv[a] += t;
        }
      }
    // v 沿 x：经过格角，流过的质量 = 两侧水平通量的平均
    for (let j = 1; j < H; j++)
      for (let i = 1; i < W; i++) {
        const fc = 0.5 * (Fu[(j - 1) * UW + i] + Fu[j * UW + i]);
        const lf = j * W + i - 1, rt = j * W + i;
        if (fc > 0) {
          const t = fc * donorV(lf, rt);
          dPv[lf] -= t;
          dPv[rt] += t;
        } else if (fc < 0) {
          const t = -fc * donorV(rt, lf);
          dPv[rt] -= t;
          dPv[lf] += t;
        }
      }

    // ---- 3.4) diag8：斜着走的那份动量沿对角直接搬 ----
    // 一份水 d 从格 (i, j) 落进 (k, l)：源格四个面（左右 u、上下 v）的面质量各少 d/2，
    // 目标格四个面各多 d/2。所以每个面的动量 d/2 · (自己的速度) 直接平移 (Δi, Δj)，
    // 一步到位、不经过中间那个面（route 要在中间面上停一步，动量跟不上质量）
    for (let q = 0; q < D.length; q += 5) {
      const i = D[q], j = D[q + 1], k = D[q + 2], l = D[q + 3], h = 0.5 * D[q + 4];
      for (let s = 0; s <= 1; s++) {
        const ua = j * UW + i + s, ub = l * UW + k + s; // 左 u 面 → 左 u 面，右 → 右
        const tu = h * donorU(ua, j * UW + i + 1 - s); // 关着就用源格另一面
        dPu[ua] -= tu;
        dPu[ub] += tu;
        const va = (j + s) * W + i, vb = (l + s) * W + k; // 上 v 面 → 上，下 → 下
        const tv = h * donorV(va, (j + 1 - s) * W + i);
        dPv[va] -= tv;
        dPv[vb] += tv;
      }
    }

    // ---- 3.5) 粘性（只有侧向）：每个面只和"侧面"那个平行面交换动量 ——
    //      u 与上下的 u、v 与左右的 v。一减一加，总动量不变，只抹平层与层之间的速度差。
    //      墙当成"速度 0、质量无穷大"的水：贴墙（域边界或墙格）的面再和墙交换一份，
    //      J = k·P，这份动量被墙吸收 —— 这就是墙的摩擦，也只是侧向的。
    const kv = Math.min(VISC_SCALE * Math.min(Math.max(viscosity, 0), 0.95) * dt, VISC_K_MAX);
    const kw = Math.min(VISC_SCALE * Math.min(Math.max(this.wallFriction, 0), 0.95) * dt, VISC_K_MAX);
    if (kv > 0 || kw > 0) {
      for (let j = 0; j < H; j++)
        for (let i = 1; i < W; i++) {
          const a = j * UW + i;
          if (!oU[a]) continue;
          // u[j][i] 与 u[j+1][i]
          if (j + 1 < H && oU[a + UW]) {
            if (kv > 0) {
              const ma = mU[a], mb = mU[a + UW];
              if (ma > EPS && mb > EPS) {
                const J = kv * Math.min(ma, mb) * (u[a] - u[a + UW]);
                dPu[a] -= J;
                dPu[a + UW] += J;
              }
            }
          } else if (kw > 0) dPu[a] -= kw * Pu[a]; // 下面是墙
          if (kw > 0 && !(j > 0 && oU[a - UW])) dPu[a] -= kw * Pu[a]; // 上面是墙
        }
      for (let j = 1; j < H; j++)
        for (let i = 0; i < W; i++) {
          const a = j * W + i;
          if (!oV[a]) continue;
          // v[j][i] 与 v[j][i+1]
          if (i + 1 < W && oV[a + 1]) {
            if (kv > 0) {
              const ma = mV[a], mb = mV[a + 1];
              if (ma > EPS && mb > EPS) {
                const J = kv * Math.min(ma, mb) * (v[a] - v[a + 1]);
                dPv[a] -= J;
                dPv[a + 1] += J;
              }
            }
          } else if (kw > 0) dPv[a] -= kw * Pv[a]; // 右边是墙
          if (kw > 0 && !(i > 0 && oV[a - 1])) dPv[a] -= kw * Pv[a]; // 左边是墙
        }
    }

    // ---- 3.6) 法向（体积）粘性：u 与左右的 u、v 与上下的 v —— 管压缩 / 膨胀（∂u/∂x、∂v/∂y）。
    //      侧向粘性只抹平层与层之间的滑动，水池上下"弹"的压缩波（v 只随 y 变）它管不到，
    //      只有侧向粘性时水怎么也停不下来；变硬（elastic 大）也没用，只是波跑得更快
    const kn = Math.min(VISC_SCALE * Math.min(Math.max(bulkViscosity, 0), 0.95) * dt, VISC_K_MAX);
    if (kn > 0) {
      for (let j = 0; j < H; j++)
        for (let i = 1; i + 1 < W; i++) {
          const a = j * UW + i;
          if (!oU[a] || !oU[a + 1]) continue;
          const ma = mU[a], mb = mU[a + 1];
          if (ma > EPS && mb > EPS) {
            const J = kn * Math.min(ma, mb) * (u[a] - u[a + 1]);
            dPu[a] -= J;
            dPu[a + 1] += J;
          }
        }
      for (let j = 1; j + 1 < H; j++)
        for (let i = 0; i < W; i++) {
          const a = j * W + i;
          if (!oV[a] || !oV[a + W]) continue;
          const ma = mV[a], mb = mV[a + W];
          if (ma > EPS && mb > EPS) {
            const J = kn * Math.min(ma, mb) * (v[a] - v[a + W]);
            dPv[a] -= J;
            dPv[a + W] += J;
          }
        }
    }

    // ---- 4) 新的质量与水块 ----
    for (let k = 0; k < n; k++) {
      const m = newm[k];
      mass[k] = m;
      const o = k * ACC;
      const D = acc[o];
      if (D <= 0 || m <= 0) {
        gA[k] = gX[k] = gY[k] = gW[k] = gH[k] = 0;
      } else {
        // 按质量加权合并：密度 ρ̄ = Σd·ρ / Σd，面积 A = Σd / ρ̄，形心、方差也按质量。
        // 原来按面积加权：一格残雾（整格大小的稀水块，面积 1）里落进一滴密的水，合并后面积被
        // 残雾的 1 主导 —— 水滴变成整格大小的稀水块，四面都漏，被拉成一条线（静止密度调到 0 再调回来
        // 之后满场都是这种残雾）。按质量加权时残雾几乎不占分量，水滴保持原来的大小。
        // 各块密度相同时两种加权完全一样（平移、下落、方块的精确性不变）
        const Ab = (D * D) / acc[o + 5];
        this.fit(k, Ab, Ab * (acc[o + 1] / D), Ab * (acc[o + 2] / D), Ab * (acc[o + 3] / D), Ab * (acc[o + 4] / D));
      }
      geoMass[k] = mass[k];
    }

    // ---- 5) 动量 → 速度（新的面质量）；墙面恒为 0 ----
    faceMass();
    for (let e = 0; e < u.length; e++) {
      const me = mU[e];
      u[e] = oU[e] && me > EPS ? (Pu[e] + dPu[e]) / me : 0;
    }
    for (let e = 0; e < v.length; e++) {
      const me = mV[e];
      v[e] = oV[e] && me > EPS ? (Pv[e] + dPv[e]) / me : 0;
    }
    capVel();
  }

  /**
   * 渲染用的密度：质量 / 水块面积。一条刚越过格子边界的满密度薄条（质量 0.05、密度 1）
   * 按质量画是一格很淡的水，按密度画就是和水体一样深的颜色 —— 浅淡只交给不透明度（按质量）。
   * 画笔刚改过、还没走过一步的格（质量 ≠ geoMass）水块还是旧的，按 resetGeo 的规则当成满密度
   */
  override renderDensity(): ArrayLike<number> {
    const { mass, rho, geoMass } = this;
    const m0 = Math.max(this.params.restDensity, 0);
    if (m0 <= 0) return mass;
    for (let k = 0; k < mass.length; k++) {
      const m = mass[k];
      if (m <= 0) rho[k] = 0;
      else if (m !== geoMass[k]) rho[k] = m >= m0 ? m : m0;
      else rho[k] = this.density(k, m, m0);
    }
    return rho;
  }

  /**
   * 渲染用的水块：和第 2 步搬运时用的矩形完全一样（满格、corner、offset、rect/blob 各自的规则）。
   * 画笔刚改过、还没走过一步的格按 resetGeo：居中的正方形，边长 √(m/m₀)
   */
  override renderBlocks(): Float32Array | null {
    const { mass, blk, geoMass, gA, gX, gY, gW, gH } = this;
    const m0 = Math.max(this.params.restDensity, 0);
    const isCorner = this.shape === "corner", isOffset = this.shape === "offset";
    for (let k = 0; k < mass.length; k++) {
      const m = mass[k], o = k * 4;
      let x0 = 0, x1 = 1, y0 = 0, y1 = 1;
      if (m <= 0) {
        x0 = x1 = y0 = y1 = 0.5;
      } else if (m0 > 0 && m < m0) {
        let A = gA[k], ex = gX[k], ey = gY[k], bw = gW[k], bh = gH[k];
        if (m !== geoMass[k]) {
          A = isCorner ? 1 : m / m0;
          ex = ey = 0;
          bw = bh = isCorner ? 0 : Math.sqrt(A);
        }
        if (isCorner) {
          bw = 1 - Math.abs(ex);
          bh = 1 - Math.abs(ey);
          ex /= 2;
          ey /= 2;
          A = bw * bh;
        } else if (isOffset) {
          A = Math.min(1, m / m0);
          bw = bh = Math.sqrt(A);
          const ox = bw >= 1 ? 0 : Math.max(-1, Math.min(1, ex / ((1 - bw) / 2)));
          const oy = bh >= 1 ? 0 : Math.max(-1, Math.min(1, ey / ((1 - bh) / 2)));
          ex = (ox * (1 - bw)) / 2;
          ey = (oy * (1 - bh)) / 2;
        }
        if (A < 1 - 1e-9) {
          x0 = 0.5 + ex - bw / 2;
          x1 = 0.5 + ex + bw / 2;
          y0 = 0.5 + ey - bh / 2;
          y1 = 0.5 + ey + bh / 2;
        }
      }
      blk[o] = x0;
      blk[o + 1] = x1;
      blk[o + 2] = y0;
      blk[o + 3] = y1;
    }
    return blk;
  }

  /** 调试：第 c 格的水块在格内的范围 [x0, x1] × [y0, y1]（0..1；满格返回整格） */
  blockOf(c: number): [number, number, number, number] {
    let ex = this.gX[c], ey = this.gY[c], w = this.gW[c], h = this.gH[c];
    if (this.shape === "corner") {
      w = 1 - Math.abs(ex);
      h = 1 - Math.abs(ey);
      ex /= 2;
      ey /= 2;
    }
    return [0.5 + ex - w / 2, 0.5 + ex + w / 2, 0.5 + ey - h / 2, 0.5 + ey + h / 2];
  }

  /** 调试：直接设定第 c 格的 corner 对 (x, y) */
  setCorner(c: number, x: number, y: number): void {
    this.gX[c] = x;
    this.gY[c] = y;
    this.gW[c] = 1 - Math.abs(x);
    this.gH[c] = 1 - Math.abs(y);
    this.gA[c] = this.gW[c] * this.gH[c];
    this.geoMass[c] = this.mass[c];
  }

  /** 鼠标指到哪一格就读哪一格（调试用；墙 / 越界返回 null） */
  probe(x: number, y: number): CellProbe | null {
    const W = this.w, H = this.h, UW = W + 1;
    if (x < 0 || y < 0 || x >= W || y >= H) return null;
    const i = y * W + x;
    if (this.kind[i] === CELL_WALL) return null;
    const p = this.p;
    const solid = (q: number) => q < 0 || q >= W * H || this.kind[q] === CELL_WALL;
    const right = x < W - 1 && !solid(i + 1) ? { dp: p[i] - p[i + 1], v: this.u[y * UW + x + 1] } : { dp: 0, v: 0 };
    const left = x > 0 && !solid(i - 1) ? { dp: p[i] - p[i - 1], v: -this.u[y * UW + x] } : { dp: 0, v: 0 };
    const down = y < H - 1 && !solid(i + W) ? { dp: p[i] - p[i + W], v: this.v[(y + 1) * W + x] } : { dp: 0, v: 0 };
    const up = y > 0 && !solid(i - W) ? { dp: p[i] - p[i - W], v: -this.v[y * W + x] } : { dp: 0, v: 0 };
    return { x, y, mass: this.mass[i], pressure: p[i], right, left, down, up };
  }
}
