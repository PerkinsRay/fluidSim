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
 * 水块是中心 + 宽 + 高的矩形（Python 原型里还有 offset / blob / corner 几种形状，平移、下落都不如 rect 准）。
 *
 * 和 Python 原型的差别：
 *   - 支持格内墙（CELL_WALL）与水源（CELL_SOURCE）；水块碰墙被挡住；
 *   - 侧向粘性（params.viscosity）：u 只和上下的 u、v 只和左右的 v 交换；墙摩擦 params.wallFriction 同理；
 *   - 斜着落进对角格的那一小块水，动量沿对角直接搬（8 方向平流，见第 3.4 步）；
 *   - 法向粘性 params.bulkViscosity：耗掉侧向粘性管不到的压缩波，水才能静下来；
 *   - 辛欧拉：先加力、再用新速度挪水（显式欧拉会满屏棋盘格）；
 *   - 内聚 cohesion（默认 0 = 关闭）：不满的水按密度往回拉，只作用在两侧都有水的面上；
 *   - 速度按矢量长度封顶 MAX_SPEED（不按分量，否则斜着能快 √2 倍），防止近乎空的面上算出极大速度；
 *   - 画笔 / 水源 / 橡皮直接改质量时，那一格的水块重置为居中（见 geoMass）。
 */
import { FluidEngine, CELL_WALL, CELL_SOURCE } from "./engine";

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

/** 一步里各阶段共用的常数（prepare 算好，多线程时随"开始"消息发给各线程） */
export interface StepCtx {
  dt: number;
  m0: number;
  c: number;
  g: number;
  vCap: number;
  k1: number;
  kv: number;
  kw: number;
  kn: number;
}

/** 压力系数：c = expansion × C_SCALE（同 engineSimple） */
const C_SCALE = 100;
/**
 * 水块的边每步最多走这么远（格）。速度上限 = MAX_MOVE / dt（dt = 0.01 时 0.5 → 50，再被 MAX_SPEED 夹）。
 * 最多 1/2：边走到 ±1，水块最远只落进紧邻的格（3×3 之内），一格最多 4 块斜着走（diagBuf 按这个分配）。
 * 原来是 1/4（上限 25）：自由落体 250 行在 g = 2 时应到 31.6，被封在 25
 */
const MAX_MOVE = 0.5;
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
    for (let dx = -r; dx <= r; dx++)
      if (dx * dx + dy * dy <= r * r) out.push([dx, dy]);
  return out.sort(
    (a, b) => a[0] * a[0] + a[1] * a[1] - (b[0] * b[0] + b[1] * b[1]),
  );
})();
const EPS = 1e-9;
/** acc 每格几个数 */
const ACC = 6;
/** 格质量超过它才算"有水"：内聚负压只作用在两侧都有水的面上 */
const WET = 0.05;
/** 不满的格合并后水块密度的上限（× 静止密度 m₀），见 refitBlocks */
const RHO_MAX = 1.5;

/**
 * 所有线程共用的数组：[名字, 类型, 长度]（n = W·H 格，nu = H·(W+1) 竖直面，nv = (H+1)·W 水平面）。
 * 单线程时就是各自 new 出来；多线程时从一块 SharedArrayBuffer 里按这个顺序切出来（每段按 8 字节对齐）
 */
type ArrKind = "f64" | "f32" | "i32" | "u8";
function memSpec(w: number, h: number): [string, ArrKind, number][] {
  const n = w * h,
    nu = h * (w + 1),
    nv = (h + 1) * w;
  return [
    ["u", "f64", nu], ["v", "f64", nv],
    ["gA", "f64", n], ["gX", "f64", n], ["gY", "f64", n], ["gW", "f64", n], ["gH", "f64", n],
    ["p", "f64", n],
    ["Pu", "f64", nu], ["Pv", "f64", nv], ["dPu", "f64", nu], ["dPv", "f64", nv],
    ["Fu", "f64", nu], ["Fv", "f64", nv],
    ["newm", "f64", n], ["acc", "f64", n * ACC],
    ["diagBuf", "f64", n * 12],
    ["mU", "f64", nu], ["mV", "f64", nv],
    ["mass", "f32", n], ["geoMass", "f32", n], ["rho", "f32", n],
    ["xLo", "i32", h], ["xHi", "i32", h], ["uLo", "i32", h], ["uHi", "i32", h],
    ["vLo", "i32", h + 1], ["vHi", "i32", h + 1],
    ["kind", "u8", n], ["oU", "u8", nu], ["oV", "u8", nv], ["lU", "u8", nu], ["lV", "u8", nv],
    ["open8", "u8", n],
  ];
}
const BYTES: Record<ArrKind, number> = { f64: 8, f32: 4, i32: 4, u8: 1 };

/** 多线程时那块共享内存要多大 */
export function sharedBytes(w: number, h: number): number {
  let off = 0;
  for (const [, k, len] of memSpec(w, h)) off += Math.ceil((len * BYTES[k]) / 8) * 8;
  return off;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeMem(w: number, h: number, buf?: SharedArrayBuffer): any {
  const out: Record<string, unknown> = {};
  let off = 0;
  for (const [name, k, len] of memSpec(w, h)) {
    // 逐个类型调构造函数（不写成"先挑出构造函数再 new"：TS 5.7+ 里几个构造函数的联合类型不收 SharedArrayBuffer）
    const b: ArrayBufferLike = buf ?? new ArrayBuffer(Math.ceil((len * BYTES[k]) / 8) * 8);
    const o = buf ? off : 0;
    out[name] =
      k === "f64" ? new Float64Array(b, o, len) : k === "f32" ? new Float32Array(b, o, len) : k === "i32" ? new Int32Array(b, o, len) : new Uint8Array(b, o, len);
    off += Math.ceil((len * BYTES[k]) / 8) * 8;
  }
  return out;
}

export class FluidEngineBlob extends FluidEngine {
  timeStep = 0.01;
  /**
   * 内聚 k1 ≥ 0：被拉稀的水（密度 ρ < m₀）往回拉，P = max(−k1·ρ, c·(ρ − m₀))。0 = 关闭。
   * 注意：0 < ρ < ρ* 这一段 P 随 ρ 下降（越稀压力越高）—— 反扩散。没有表面张力项时
   * k1 太大会在网格尺度上抖动、水越摊越开（Python 原型：elastic 50、dt 0.01 时 k1 ≤ 5 不起振）
   */
  cohesion = 0;

  /** 面速度（跨步保留） */
  readonly u: Float64Array<ArrayBufferLike>;
  readonly v: Float64Array<ArrayBufferLike>;

  /**
   * 每格的水块（格内坐标，中心相对格心）：
   *   gA 面积（几何面积，与质量分开记 —— 被拉开的水面积不变、只是变稀）
   *   gX, gY 中心偏移 ∈ [−0.5, 0.5]（存偏移而不存 0..1：贴左 / 贴右两侧精度相同，镜像不被舍入打破）
   *   gW, gH 宽、高
   */
  private gA: Float64Array<ArrayBufferLike>;
  private gX: Float64Array<ArrayBufferLike>;
  private gY: Float64Array<ArrayBufferLike>;
  private gW: Float64Array<ArrayBufferLike>;
  private gH: Float64Array<ArrayBufferLike>;
  /** 拟合水块时的质量：与当前质量不同 ⇒ 这一格被画笔 / 水源 / 橡皮改过，水块重置 */
  private geoMass: Float32Array<ArrayBufferLike>;

  // 工作区
  private p: Float64Array<ArrayBufferLike>;
  private Pu: Float64Array<ArrayBufferLike>;
  private Pv: Float64Array<ArrayBufferLike>;
  private dPu: Float64Array<ArrayBufferLike>;
  private dPv: Float64Array<ArrayBufferLike>;
  private Fu: Float64Array<ArrayBufferLike>;
  private Fv: Float64Array<ArrayBufferLike>;
  private newm: Float64Array<ArrayBufferLike>;
  /** 每格收到的水块的矩，按**质量**加权：[Σd, Σd·ξ, Σd·η, Σd·ξ², Σd·η², Σd·ρ]（相对格心），见第 4 步 */
  private acc: Float64Array<ArrayBufferLike>;
  /**
   * 斜着落进对角格的每一小块：(源格, 目标格, d) 依次排开（见第 3.4 步）。
   * 一开始就按最坏情况分配（一块水最多盖住 3×3 格，四个角上各一块斜着的：每格 4 组），不中途扩容 ——
   * 扩容会换掉数组，正在跑的优化代码因此作废重编，256×256 时那一步要卡 50 ms
   */
  private diagBuf: Float64Array<ArrayBufferLike>;
  /** 水源格列表（墙 / 水源变了才重算） */
  private srcList = new Int32Array(0);
  /** 这一步质量被外部改过的格（画笔 / 水源 / 橡皮） */
  private touched = new Int32Array(0);
  /** 速度封顶用的旧速度副本 */
  private capU: Float64Array<ArrayBufferLike>;
  private capV: Float64Array<ArrayBufferLike>;
  /**
   * 每步预先算好：面的种类、面质量 m_e。
   *   oU / oV：0 = 死面（两侧都是墙 / 域外，没有水）；1 = 两侧都是水格；
   *            2 = 墙在下标小的那侧（左 / 上），水在另一侧；3 = 墙在下标大的那侧（右 / 下）
   *   墙面（2、3）也存速度 —— 它管贴墙那半格水，面质量 = 那一格的一半（墙外没有水）
   */
  private oU: Uint8Array<ArrayBufferLike>;
  private oV: Uint8Array<ArrayBufferLike>;
  private mU: Float64Array<ArrayBufferLike>;
  private mV: Float64Array<ArrayBufferLike>;
  /** 上次算 oU / oV 时的格类型：墙没变就不重算 */
  private kindSeen: Uint8Array<ArrayBufferLike>;
  /** 格的 8 个邻格都在域内、都不是墙（墙变了才重算）：满格搬运走快路，不用查墙、不用逐块量面积 */
  private open8: Uint8Array;
  /** mU / mV 是按当前质量算的（上一步末尾算好；外部直接改 mass 后 nT > 0 会重算） */
  private faceMassOk = false;
  /**
   * 侧向粘性的配对（墙变了才重算）：
   *   lU[a]：u[a] 与下面的 u[a + W + 1] 共用一列水格（可以交换）；1 位 = 可交换，2 位 = 上面是墙，4 位 = 下面是墙
   *   lV[a]：v[a] 与右边的 v[a + 1] 同理；1 = 可交换，2 = 左边是墙，4 = 右边是墙
   */
  private lU: Uint8Array<ArrayBufferLike>;
  private lV: Uint8Array<ArrayBufferLike>;
  /** 墙面列表（墙变了才重算）：wU / wV 是面的下标，cU / cV 是贴着它的那一格（wallClamp 只扫这些面） */
  private wU = new Int32Array(0);
  private cU = new Int32Array(0);
  private wV = new Int32Array(0);
  private cV = new Int32Array(0);
  /** edges() 的输出 */
  private edgeBuf = new Float64Array(4);
  /**
   * 这一步要算的范围（每行一段，见 advance 开头）：xLo..xHi 格、uLo..uHi 竖直面（按格行）、
   * vLo..vHi 水平面（按面行 0..H）；wLo / wHi 是每行有水的格的范围（临时）。空 = lo > hi
   */
  private xLo: Int32Array<ArrayBufferLike>;
  private xHi: Int32Array<ArrayBufferLike>;
  private uLo: Int32Array<ArrayBufferLike>;
  private uHi: Int32Array<ArrayBufferLike>;
  private vLo: Int32Array<ArrayBufferLike>;
  private vHi: Int32Array<ArrayBufferLike>;
  private wLo: Int32Array<ArrayBufferLike>;
  private wHi: Int32Array<ArrayBufferLike>;
  /** renderDensity 的输出 */
  private rho: Float32Array<ArrayBufferLike>;
  /** renderBlocks 的输出：每格 [x0, x1, y0, y1] */
  private blk: Float32Array<ArrayBufferLike>;

  /**
   * shared：多线程时所有线程共用的状态放在这一块共享内存里（大小见 sharedBytes，布局见 memSpec）。
   * 各线程用同一块内存各建一个引擎，按行分段算同一步（见 parEngine.ts）。不给就是普通的单线程引擎
   */
  constructor(w: number, h: number, shared?: SharedArrayBuffer) {
    const mem = makeMem(w, h, shared);
    super(w, h, mem);
    const n = w * h;
    this.u = mem.u;
    this.v = mem.v;
    this.gA = mem.gA;
    this.gX = mem.gX;
    this.gY = mem.gY;
    this.gW = mem.gW;
    this.gH = mem.gH;
    this.geoMass = mem.geoMass;
    this.p = mem.p;
    this.Pu = mem.Pu;
    this.Pv = mem.Pv;
    this.dPu = mem.dPu;
    this.dPv = mem.dPv;
    this.Fu = mem.Fu;
    this.Fv = mem.Fv;
    this.newm = mem.newm;
    this.acc = mem.acc;
    this.diagBuf = mem.diagBuf;
    this.oU = mem.oU;
    this.oV = mem.oV;
    this.mU = mem.mU;
    this.mV = mem.mV;
    this.open8 = mem.open8;
    this.lU = mem.lU;
    this.lV = mem.lV;
    this.xLo = mem.xLo;
    this.xHi = mem.xHi;
    this.uLo = mem.uLo;
    this.uHi = mem.uHi;
    this.vLo = mem.vLo;
    this.vHi = mem.vHi;
    // 下面这些只有主线程（或单线程）用，每个线程自己一份
    this.capU = new Float64Array(h * (w + 1));
    this.capV = new Float64Array((h + 1) * w);
    this.kindSeen = new Uint8Array(n).fill(255);
    this.rho = mem.rho;
    this.blk = new Float32Array(n * 4);
    this.wLo = new Int32Array(h);
    this.wHi = new Int32Array(h);
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
    this.faceMassOk = false;
  }

  override step(): void {
    this.advance(this.timeStep);
    this.stepCount++;
  }

  /**
   * 格 (i, j) 那一行 u 的局部插值：左右两个面 a、b，s ∈ [−0.5, 0.5]。
   * 写成"中点 + 偏移 × 差"的形式：左右镜像时 s → −s、两侧面速度互换并取反，结果逐位取反。
   * 墙面也存速度（贴墙那半格水的速度，见 wallClamp），和别的面一视同仁。
   * 这一格本身是墙返回 NaN（这一行没有水的速度）
   */
  private uRow(j: number, i: number, s: number): number {
    if (this.kind[j * this.w + i] === CELL_WALL) return NaN;
    const e = j * (this.w + 1) + i,
      u = this.u;
    const a = u[e],
      b = u[e + 1];
    return 0.5 * (a + b) + s * (b - a);
  }

  /** 格 (i, j) 那一列 v 的局部插值（同 uRow，横竖对调） */
  private vCol(j: number, i: number, t: number): number {
    const W = this.w;
    if (this.kind[j * W + i] === CELL_WALL) return NaN;
    const e = j * W + i,
      v = this.v;
    const a = v[e],
      b = v[e + W];
    return 0.5 * (a + b) + t * (b - a);
  }

  /**
   * 格 (i, j) 内局部点 (s, t)（相对格心，−0.5..0.5）处的水平速度：本行按 uRow，
   * 再往 t 那一侧的相邻行插一点（那一行是墙格就不插）
   */
  private uLocal(i: number, j: number, s: number, t: number): number {
    const val = this.uRow(j, i, s);
    if (val !== val) return 0;
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

  /**
   * 格 c 那块水的四条边（相对格心，−0.5..0.5），写进 out：[左, 右, 上, 下]。
   * 满格（或静止密度为 0）时就是整格。第 2 步搬运、墙、渲染都用这一份
   */
  private edges(c: number, m0: number, out: Float64Array): void {
    const m = this.mass[c];
    if (m0 <= 0 || m >= m0 || this.gA[c] >= 1 - 1e-9) {
      out[0] = out[2] = -0.5;
      out[1] = out[3] = 0.5;
      return;
    }
    const ex = this.gX[c], ey = this.gY[c], hw = this.gW[c] / 2, hh = this.gH[c] / 2;
    out[0] = ex - hw;
    out[1] = ex + hw;
    out[2] = ey - hh;
    out[3] = ey + hh;
  }

  /**
   * 墙面只有一条规矩：撞上墙的水停下。
   * 墙面和别的面一样存速度（那是贴墙那半格水的速度），只在水块**这一步之内会碰到墙**
   * （离墙 ≤ |速度|·dt）时，把指向墙里的那部分清零 —— 这份动量被墙吸收（非弹性地撞上墙）。
   * 离开墙、沿着墙走、还在往墙落的水都不管。四面墙、格内墙同一条规则；只会清零，只耗能量、不加能量。
   * 为什么不是"碰到了才清"：一层很薄、差一点贴到墙的水，往墙里的速度永远清不掉，压力每步还在往上加 ——
   * 几乎没有质量的面速度冲到 200（Python 实测能量从 1 涨到 347）。
   * 为什么不是"格里有水就清"：往地面落、还没落到底的水也被清掉，下沿停在半空 ——
   * 擦掉最底一行时流进来的水落不到底（800 步只填回 9/16）
   */
  private wallClamp(withP: boolean, dt: number): void {
    const { u, v, oU, oV, Pu, Pv, mass, wU, cU, wV, cV } = this;
    const eg = this.edgeBuf,
      m0 = Math.max(this.params.restDensity, 0),
      tol = 1e-6;
    // 只扫墙面（列表墙变了才重算）。水块那一侧的边离墙多远：左 / 上是 边 + 0.5，右 / 下是 0.5 − 边
    for (let q = 0; q < wU.length; q++) {
      const e = wU[q], vel = u[e];
      const left = oU[e] === 2; // 墙在左
      if (left ? vel >= 0 : vel <= 0) continue; // 不往墙里走
      const c = cU[q];
      if (mass[c] <= 0) continue;
      this.edges(c, m0, eg);
      const gap = left ? eg[0] + 0.5 : 0.5 - eg[1];
      if (gap > Math.abs(vel) * dt + tol) continue; // 这一步碰不到墙
      u[e] = 0;
      if (withP) Pu[e] = 0;
    }
    for (let q = 0; q < wV.length; q++) {
      const e = wV[q], vel = v[e];
      const up = oV[e] === 2; // 墙在上
      if (up ? vel >= 0 : vel <= 0) continue;
      const c = cV[q];
      if (mass[c] <= 0) continue;
      this.edges(c, m0, eg);
      const gap = up ? eg[2] + 0.5 : 0.5 - eg[3];
      if (gap > Math.abs(vel) * dt + tol) continue;
      v[e] = 0;
      if (withP) Pv[e] = 0;
    }
  }

  /** 由矩拟合水块，写回第 c 格 */
  private fit(
    c: number,
    A: number,
    Ax: number,
    Ay: number,
    Axx: number,
    Ayy: number,
  ): void {
    const ex = Ax / A,
      ey = Ay / A;
    const a = Math.min(A, 1);
    const vx = Math.max(Axx / A - ex * ex, 1e-12);
    const vy = Math.max(Ayy / A - ey * ey, 1e-12);
    const r = Math.sqrt(vx / vy); // 宽 / 高 = 两个方向标准差之比
    let w = Math.sqrt(a * r),
      h = Math.sqrt(a / r);
    if (w > 1) {
      w = 1;
      h = Math.min(1, a);
    }
    if (h > 1) {
      h = 1;
      w = Math.min(1, a);
    }
    const lx = (1 - w) / 2,
      ly = (1 - h) / 2;
    this.gA[c] = a;
    this.gX[c] = Math.max(-lx, Math.min(lx, ex));
    this.gY[c] = Math.max(-ly, Math.min(ly, ey));
    this.gW[c] = w;
    this.gH[c] = h;
  }

  /** 第 c 格那块水的密度 = 质量 / 水块面积（与搬运时重建水块的方式一致） */
  private density(c: number, m: number): number {
    const A = this.gA[c];
    return A > 1e-12 ? m / A : m;
  }

  /** 第 c 格的质量被外部改过：水块重置为居中、按满密度的面积 */
  private resetGeo(c: number, m0: number): void {
    const m = this.mass[c];
    const a = m <= 0 ? 0 : m0 > 0 ? Math.min(1, m / m0) : 1;
    const s = Math.sqrt(a);
    this.gA[c] = a;
    this.gX[c] = 0;
    this.gY[c] = 0;
    this.gW[c] = s;
    this.gH[c] = s;
    this.geoMass[c] = m;
  }

  /**
   * 第 2 步：每格的水块按边速度挪一步，按重叠面积分进各格（newm、矩 acc），
   * 记下面通量 Fu / Fv；斜着落进对角格的小块记进 diagBuf，返回用了多少个数。
   * 单独成一个方法：它最长、分支最多，和 advance 写在一起时任何一处罕见分支第一次走到，
   * 整个 advance 的优化代码都会被扔掉重来（256×256 时每次 70–80 ms 的卡顿）
   */
  moveBlocks(dt: number, m0: number, j0: number, j1: number, D0: number): number {
    // Fu / Fv / newm / acc 在这里一直是 0：上一步用完已经在它的范围内清零（见 phaseVel / refitBlocks）。
    // 只挪格行 j0..j1−1 的水块（会落进上下各一行：多线程时分两色算）；斜着的块从 diagBuf[D0] 往后记，返回记到哪
    // （各段各用自己那一截 diagBuf，互不覆盖）
    const { Fu, Fv, newm, acc, mass, kind, u, v, xLo, xHi } = this;
    const W = this.w,
      H = this.h,
      UW = W + 1;
    const clampMove = (d: number) =>
      d > MAX_MOVE ? MAX_MOVE : d < -MAX_MOVE ? -MAX_MOVE : d;
    const D = this.diagBuf;
    let nD = D0;
    // 循环里要用的字段先取成局部变量（每格都读 this.xxx，占了这一段一半的时间）
    const gA = this.gA;
    const o8 = this.open8;
    const eg = this.edgeBuf;
    for (let j = j0; j < j1; j++) {
      for (let i = xLo[j]; i <= xHi[j]; i++) {
        const src = j * W + i;
        const m = mass[src];
        if (m <= 0 || kind[src] === CELL_WALL) continue;
        // 所有位置都相对**格心**算（−0.5..0.5），不用全局坐标：全局坐标的舍入随格号变，
        // 左右镜像的两块水从第 1 步起就差 1e-15，之后被流动放大成肉眼可见的不对称
        let a0: number, a1: number, b0: number, b1: number;
        let na0: number, na1: number, nb0: number, nb1: number;
        // 快路：满格且 8 个邻格都不是墙（水体内部）—— 不会碰墙、不会被压成线，整块面积就是两边长之积
        let fast = false;
        if (m0 <= 0 || m >= m0 || gA[src] >= 1 - 1e-9) {
          // 满格（水体内部，大多数格）：四条边正好落在四个面上，边速度就是面速度 —— 不用插值
          a0 = b0 = -0.5;
          a1 = b1 = 0.5;
          const eu = j * UW + i;
          na0 = -0.5 + clampMove(u[eu] * dt);
          na1 = 0.5 + clampMove(u[eu + 1] * dt);
          nb0 = -0.5 + clampMove(v[src] * dt);
          nb1 = 0.5 + clampMove(v[src + W] * dt);
          // 两边各往里走满 1/2 时会被压成一条线：那种格走下面的慢路（那里给它一个极小的宽度）
          fast = o8[src] === 1 && na1 - na0 >= 1e-9 && nb1 - nb0 >= 1e-9;
        } else {
          this.edges(src, m0, eg);
          a0 = eg[0];
          a1 = eg[1];
          b0 = eg[2];
          b1 = eg[3];
          const ac = (a0 + a1) / 2,
            bc = (b0 + b1) / 2;
          na0 = a0 + clampMove(this.uLocal(i, j, a0, bc) * dt);
          na1 = a1 + clampMove(this.uLocal(i, j, a1, bc) * dt);
          nb0 = b0 + clampMove(this.vLocal(i, j, ac, b0) * dt);
          nb1 = b1 + clampMove(this.vLocal(i, j, ac, b1) * dt);
        }
        let dk0: number, dk1: number, dl0: number, dl1: number, rho: number;
        if (fast) {
          // 边各走 ≤ 1/2 格：左 / 上边在 [−1, 0]，右 / 下边在 [0, 1] —— 只会落进紧邻的格
          dk0 = na0 < -0.5 ? -1 : 0;
          dk1 = na1 > 0.5 ? 1 : 0;
          dl0 = nb0 < -0.5 ? -1 : 0;
          dl1 = nb1 > 0.5 ? 1 : 0;
          rho = m / ((na1 - na0) * (nb1 - nb0));
        } else {
        // 墙 / 域边界挡住（每步最多走 1/2 格，所以只可能碰到紧邻的格）。两端都夹，
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
          const cc = Math.min(
            Math.max((na0 + na1) / 2, loX + 5e-10),
            hiX - 5e-10,
          );
          na0 = cc - 5e-10;
          na1 = cc + 5e-10;
        }
        if (nb1 - nb0 < 1e-9) {
          const cc = Math.min(
            Math.max((nb0 + nb1) / 2, loY + 5e-10),
            hiY - 5e-10,
          );
          nb0 = cc - 5e-10;
          nb1 = cc + 5e-10;
        }
        // 落进哪几格：相对坐标下格 i + dk 占 [dk − 0.5, dk + 0.5]
        dk0 = Math.max(Math.floor(na0 + 0.5), -i);
        dk1 = Math.min(Math.floor(na1 + 0.5), W - 1 - i);
        dl0 = Math.max(Math.floor(nb0 + 0.5), -j);
        dl1 = Math.min(Math.floor(nb1 + 0.5), H - 1 - j);
        // 斜对角那一格若是墙：那一块不要，密度按剩下的面积重算（质量照样守恒）
        let aOk = 0;
        for (let dl = dl0; dl <= dl1; dl++) {
          const q0 = Math.max(nb0, dl - 0.5),
            q1 = Math.min(nb1, dl + 0.5);
          if (q1 <= q0) continue;
          for (let dk = dk0; dk <= dk1; dk++) {
            if (kind[(j + dl) * W + i + dk] === CELL_WALL) continue;
            const p0 = Math.max(na0, dk - 0.5),
              p1 = Math.min(na1, dk + 0.5);
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
        rho = m / aOk;
        }
        for (let dl = dl0; dl <= dl1; dl++) {
          const q0 = Math.max(nb0, dl - 0.5),
            q1 = Math.min(nb1, dl + 0.5);
          if (q1 <= q0) continue;
          const l = j + dl;
          for (let dk = dk0; dk <= dk1; dk++) {
            const k = i + dk;
            const dst = l * W + k;
            if (kind[dst] === CELL_WALL) continue;
            const p0 = Math.max(na0, dk - 0.5),
              p1 = Math.min(na1, dk + 0.5);
            if (p1 <= p0) continue;
            const a = (p1 - p0) * (q1 - q0);
            const d = rho * a;
            newm[dst] += d;
            // 落进格 k 后，相对**它自己**格心的坐标；二阶矩写成对两端对称的形式（镜像时逐位相同）
            const lx0 = p0 - dk,
              lx1 = p1 - dk,
              ly0 = q0 - dl,
              ly1 = q1 - dl;
            const o = dst * ACC;
            acc[o] += d;
            acc[o + 1] += (d * (lx0 + lx1)) / 2;
            acc[o + 2] += (d * (ly0 + ly1)) / 2;
            acc[o + 3] += (d * (lx0 * lx0 + lx1 * lx1 + lx0 * lx1)) / 3;
            acc[o + 4] += (d * (ly0 * ly0 + ly1 * ly1 + ly0 * ly1)) / 3;
            acc[o + 5] += d * rho;
            // 面通量：这份水从 (i, j) 走到了 (k, l)。斜着走的不记成面通量，动量在第 3.4 步沿对角直接搬
            if (dk !== 0 && dl !== 0) {
              D[nD++] = src;
              D[nD++] = dst;
              D[nD++] = d;
            }
            else if (dk === 1) Fu[j * UW + k] += d;
            else if (dk === -1) Fu[j * UW + i] -= d;
            else if (dl === 1) Fv[l * W + i] += d;
            else if (dl === -1) Fv[j * W + i] -= d;
          }
        }
      }
    }
    return nD;
  }

  /** 第 4 步：新的质量与水块（范围外的格一直是空的） */
  refitBlocks(j0: number, j1: number, m0: number): void {
    const { mass, newm, acc, gA, gX, gY, gW, gH, geoMass, xLo, xHi } = this;
    const W = this.w;
    for (let j = j0; j < j1; j++)
    for (let k = j * W + xLo[j], ke = j * W + xHi[j]; k <= ke; k++) {
      const m = newm[k];
      mass[k] = m;
      const o = k * ACC;
      const D = acc[o];
      if (D <= 0 || m <= 0) {
        gA[k] = gX[k] = gY[k] = gW[k] = gH[k] = 0;
      } else if (D * D >= acc[o + 5]) {
        // 面积 ≥ 1（水体内部的满格，绝大多数）：fit 的结果就是整格 —— 不用开方、不用除
        gA[k] = gW[k] = gH[k] = 1;
        gX[k] = gY[k] = 0;
      } else {
        // 按质量加权合并：密度 ρ̄ = Σd·ρ / Σd，面积 A = Σd / ρ̄，形心、方差也按质量。
        // 原来按面积加权：一格残雾（整格大小的稀水块，面积 1）里落进一滴密的水，合并后面积被
        // 残雾的 1 主导 —— 水滴变成整格大小的稀水块，四面都漏，被拉成一条线（静止密度调到 0 再调回来
        // 之后满场都是这种残雾）。按质量加权时残雾几乎不占分量，水滴保持原来的大小。
        // 各块密度相同时两种加权完全一样（平移、下落、方块的精确性不变）
        let Ab = (D * D) / acc[o + 5];
        // 不满的格密度最多 RHO_MAX·m₀：几块水挤进同一格时会拼出一条极薄、极密的水块（实测 ρ 到 40），
        // 压力把它和邻格推得飞快。面积撑大到 m/(RHO_MAX·m₀)：质量、形心不变，只是没那么密
        if (m0 > 0 && Ab * RHO_MAX * m0 < m) Ab = m / (RHO_MAX * m0);
        this.fit(
          k,
          Ab,
          Ab * (acc[o + 1] / D),
          Ab * (acc[o + 2] / D),
          Ab * (acc[o + 3] / D),
          Ab * (acc[o + 4] / D),
        );
      }
      geoMass[k] = mass[k];
    }
  }

  /**
   * 一步拆成几个阶段（多线程时各线程按行分段同时算同一个阶段，阶段之间等齐，见 parPool.ts）：
   *   prepare（只在主线程）→ 压力 → 力 → 墙 / 封顶（主线程）→ 挪水块（分两色）→ 动量（分两色）
   *   → 新水块 → 新速度 → 墙 / 封顶（主线程）
   * "分两色"：这两步会往相邻一两行里写（水块落进上下的格、动量搬到上下的面），
   * 先算双号段、再算单号段 —— 同时算的段之间隔着至少 3 行，写不到一起。
   * 单线程就是每个阶段都算整张图（0..H 行），和原来逐位相同
   */
  private advance(timeStep: number): void {
    const H = this.h;
    const x = this.prepare(timeStep);
    this.phasePressure(x, 0, H);
    this.phaseForce(x, 0, H);
    this.clampPhase(x, true, this.maxU, this.maxV);
    const nD = this.moveBlocks(x.dt, x.m0, 0, H, 0);
    this.phaseMomentum(x, 0, H, 0, nD);
    this.refitBlocks(0, H, x.m0);
    this.phaseVel(x, 0, H);
    this.clampPhase(x, false, this.maxU, this.maxV);
  }

  /** 第 0 步（只在主线程）：墙变了重建表、水源、画笔改过的格、这一步的范围；返回各阶段要用的常数 */
  prepare(timeStep: number): StepCtx {
    const W = this.w,
      H = this.h,
      n = W * H,
      UW = W + 1;
    const { mass, kind, u, v } = this;
    const { gravity, expansion, restDensity, viscosity, bulkViscosity } =
      this.params;
    const c = Math.max(expansion, 0) * C_SCALE;
    const g = Math.max(gravity, 0);
    const m0 = Math.max(restDensity, 0);
    // 声速 CFL：dt ≤ 0.5/√(2c + g)
    const dt = Math.min(timeStep, 0.5 / Math.sqrt(2 * c + g + 1e-6));
    const vCap = Math.min(MAX_SPEED, MAX_MOVE / dt);
    // 面的开闭、面质量：每步查表，不在每个循环里调闭包、重算 0.5·(m + m)（结果逐位相同）
    const { oU, oV, mU, mV, kindSeen, lU, lV } = this;
    let kindChanged = false;
    for (let k = 0; k < n; k++)
      if (kind[k] !== kindSeen[k]) {
        kindChanged = true;
        break;
      }
    const fluid = (j: number, i: number) =>
      i >= 0 && i < W && j >= 0 && j < H && kind[j * W + i] !== CELL_WALL;
    if (kindChanged) {
      kindSeen.set(kind);
      // 墙格里不能有水（画墙、预设都会清零；这里兜底 —— 面质量的式子靠它省掉分支）
      for (let k = 0; k < n; k++) if (kind[k] === CELL_WALL) mass[k] = 0;
      for (let j = 0; j < H; j++)
        for (let i = 0; i <= W; i++) {
          const L = fluid(j, i - 1),
            R = fluid(j, i);
          oU[j * UW + i] = L && R ? 1 : R ? 2 : L ? 3 : 0;
        }
      for (let j = 0; j <= H; j++)
        for (let i = 0; i < W; i++) {
          const U = fluid(j - 1, i),
            D = fluid(j, i);
          oV[j * W + i] = U && D ? 1 : D ? 2 : U ? 3 : 0;
        }
      // 侧向粘性的配对：两个平行面只在**共用一列（行）水格**时才交换 —— 不隔着墙角斜着传动量
      for (let j = 0; j < H; j++)
        for (let i = 0; i <= W; i++) {
          const a = j * UW + i;
          if (!oU[a]) {
            lU[a] = 0;
            continue;
          }
          const below = j + 1 < H && oU[a + UW] !== 0;
          const linked = below && ((fluid(j, i - 1) && fluid(j + 1, i - 1)) || (fluid(j, i) && fluid(j + 1, i)));
          const wallUp = !(j > 0 && oU[a - UW] !== 0);
          lU[a] = (linked ? 1 : 0) | (wallUp ? 2 : 0) | (!linked && !below ? 4 : 0);
        }
      for (let j = 0; j <= H; j++)
        for (let i = 0; i < W; i++) {
          const a = j * W + i;
          if (!oV[a]) {
            lV[a] = 0;
            continue;
          }
          const right = i + 1 < W && oV[a + 1] !== 0;
          const linked = right && ((fluid(j - 1, i) && fluid(j - 1, i + 1)) || (fluid(j, i) && fluid(j, i + 1)));
          const wallLeft = !(i > 0 && oV[a - 1] !== 0);
          lV[a] = (linked ? 1 : 0) | (wallLeft ? 2 : 0) | (!linked && !right ? 4 : 0);
        }
      // 墙面列表：面下标 + 贴着它的那一格
      let nu = 0,
        nv = 0;
      for (let e = 0; e < oU.length; e++) if (oU[e] >= 2) nu++;
      for (let e = 0; e < oV.length; e++) if (oV[e] >= 2) nv++;
      const wU = new Int32Array(nu), cU = new Int32Array(nu), wV = new Int32Array(nv), cV = new Int32Array(nv);
      nu = nv = 0;
      for (let j = 0; j < H; j++)
        for (let i = 0; i <= W; i++) {
          const e = j * UW + i;
          if (oU[e] === 2) { wU[nu] = e; cU[nu++] = j * W + i; }
          else if (oU[e] === 3) { wU[nu] = e; cU[nu++] = j * W + i - 1; }
        }
      for (let e = 0; e < oV.length; e++) {
        if (oV[e] === 2) { wV[nv] = e; cV[nv++] = e; }
        else if (oV[e] === 3) { wV[nv] = e; cV[nv++] = e - W; }
      }
      this.wU = wU; this.cU = cU; this.wV = wV; this.cV = cV;
      let ns = 0;
      for (let k = 0; k < n; k++) if (kind[k] === CELL_SOURCE) ns++;
      const sl = new Int32Array(ns);
      ns = 0;
      for (let k = 0; k < n; k++) if (kind[k] === CELL_SOURCE) sl[ns++] = k;
      this.srcList = sl;
      const o8 = this.open8;
      o8.fill(0);
      for (let j = 1; j < H - 1; j++)
        for (let i = 1; i < W - 1; i++) {
          const k = j * W + i;
          let ok = 1;
          for (let q = k - W - 1; q <= k + W - 1 && ok; q += W)
            if (kind[q] === CELL_WALL || kind[q + 1] === CELL_WALL || kind[q + 2] === CELL_WALL) ok = 0;
          o8[k] = ok;
        }
    }
    // 面质量：两侧各半格；墙面只有水那一侧的半格。
    // 墙格的质量恒为 0（画墙时清零，搬运、水源、画笔都不往墙格里放水），所以所有面都是同一个式子
    // 0.5·(左 + 右)，域外按 0 —— 不用按面的种类分支
    // mU / mV 平时在第 5 步（算新速度时）顺手写好；画笔改过的格在下面 fixU / fixV 里更新
    const { xLo, xHi, uLo, uHi, vLo, vHi } = this;

    // ---- 水源注入：先灌满水源格，溢出由近到远补进周围没满的格（只扫水源格列表）----
    const srcList = this.srcList;
    for (let q = 0; q < srcList.length; q++) {
      const k = srcList[q];
      let add = this.sourceRate * dt;
      if (m0 <= 0) {
        mass[k] += add;
        continue;
      }
      const sx = k % W,
        sy = (k - sx) / W;
      for (let r = 0; r < SOURCE_RING.length && add > 1e-9; r++) {
        const x = sx + SOURCE_RING[r][0],
          y = sy + SOURCE_RING[r][1];
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
    // 只处理改过的格和它们的面（水源每步都在改，原来每步重建一遍全图的面质量：rain 每步 1.7 ms）
    const geoMass = this.geoMass;
    if (this.touched.length < n) this.touched = new Int32Array(n);
    const touched = this.touched;
    let nT = 0;
    for (let k = 0; k < n; k++) if (mass[k] !== geoMass[k]) touched[nT++] = k;
    if (nT > 0) {
      // 一个面的面质量 = 两侧格的一半之和；格 k 改了，它的四个面都要按旧 / 新面质量缩速度。
      // 同一个面两侧都改了的话只处理一次（先标记）
      const seenU = this.capU, seenV = this.capV; // 借用：这里只当标记用，clampPhase 会整个覆盖
      const UWn = UW;
      const mOldU = (j: number, i: number) =>
        0.5 * ((i > 0 ? geoMass[j * W + i - 1] : 0) + (i < W ? geoMass[j * W + i] : 0));
      const mOldV = (e: number) =>
        0.5 * ((e >= W ? geoMass[e - W] : 0) + (e < n ? geoMass[e] : 0));
      const fixU = (j: number, i: number) => {
        const e = j * UWn + i;
        if (seenU[e] === 1) return;
        seenU[e] = 1;
        const mOld = mOldU(j, i);
        const mNew = 0.5 * ((i > 0 ? mass[j * W + i - 1] : 0) + (i < W ? mass[j * W + i] : 0));
        mU[e] = mNew; // 面质量跟着改（见下面"面质量"）
        if (mOld <= 0 || mNew <= 0) u[e] = 0;
        else if (mNew > mOld) u[e] *= mOld / mNew;
      };
      const fixV = (e: number) => {
        if (seenV[e] === 1) return;
        seenV[e] = 1;
        const mOld = mOldV(e);
        const mNew = 0.5 * ((e >= W ? mass[e - W] : 0) + (e < n ? mass[e] : 0));
        mV[e] = mNew;
        if (mOld <= 0 || mNew <= 0) v[e] = 0;
        else if (mNew > mOld) v[e] *= mOld / mNew;
      };
      // 面质量变成 0（橡皮擦光）或原来就是 0 的面，速度清零 —— 下面只算有水的范围，
      // 范围外留下的旧速度不会再被谁清掉，等水再流过来就成了凭空的速度
      for (let q = 0; q < nT; q++) {
        const k = touched[q], j = (k / W) | 0, i = k - j * W;
        fixU(j, i);
        fixU(j, i + 1);
        fixV(k);
        fixV(k + W);
      }
      // 标记清回 0
      for (let q = 0; q < nT; q++) {
        const k = touched[q], j = (k / W) | 0, i = k - j * W;
        seenU[j * UWn + i] = seenU[j * UWn + i + 1] = 0;
        seenV[k] = seenV[k + W] = 0;
      }
      for (let q = 0; q < nT; q++) this.resetGeo(touched[q], m0);
    }

    // ---- 这一步要算的范围：每行有水的格的列范围，往外扩 2 行 2 列 ----
    // 一步最多走 1/2 格，扩 2 足够把这一步里所有的读写都包进去。范围外的格一直是空的，
    // 面质量、速度一直是 0；通量和工作区（Fu / Fv / newm / acc）每步用完在范围内清零，范围外也一直是 0。
    // 所以下面的循环只扫范围内 —— 空的地方不花时间（256×256 的空网格原来每步 7 ms）
    {
      const { wLo, wHi } = this;
      for (let j = 0; j < H; j++) {
        const r = j * W;
        let lo = -1,
          hi = -1;
        for (let i = 0; i < W; i++)
          if (mass[r + i] > 0) {
            if (lo < 0) lo = i;
            hi = i;
          }
        wLo[j] = lo;
        wHi[j] = hi;
      }
      for (let j = 0; j < H; j++) {
        let lo = W,
          hi = -1;
        for (let r = Math.max(0, j - 2), re = Math.min(H - 1, j + 2); r <= re; r++)
          if (wHi[r] >= 0) {
            if (wLo[r] < lo) lo = wLo[r];
            if (wHi[r] > hi) hi = wHi[r];
          }
        if (hi < 0) {
          xLo[j] = uLo[j] = 0;
          xHi[j] = uHi[j] = -1;
        } else {
          xLo[j] = uLo[j] = Math.max(0, lo - 2);
          xHi[j] = Math.min(W - 1, hi + 2);
          uHi[j] = xHi[j] + 1;
        }
      }
      for (let r = 0; r <= H; r++) {
        let lo = W,
          hi = -1;
        if (r > 0 && xHi[r - 1] >= 0) {
          lo = xLo[r - 1];
          hi = xHi[r - 1];
        }
        if (r < H && xHi[r] >= 0) {
          if (xLo[r] < lo) lo = xLo[r];
          if (xHi[r] > hi) hi = xHi[r];
        }
        vLo[r] = hi < 0 ? 0 : lo;
        vHi[r] = hi;
      }
    }
    // 面质量：上一步末尾（第 5 步）已经按这一份质量算好、存在 mU / mV 里 ——
    // 只有质量被外部改过（画笔 / 水源 / 橡皮 / 墙）或第一步、clear 之后才要重算。
    // 范围外的面：两侧一直没水，上一步也在上一步的范围外或被写成了 0
    if (kindChanged || !this.faceMassOk) {
      // 整张图重算（墙变了、第一步、clear 之后）
      for (let j = 0; j < H; j++)
        for (let i = 0; i <= W; i++)
          mU[j * UW + i] = 0.5 * ((i > 0 ? mass[j * W + i - 1] : 0) + (i < W ? mass[j * W + i] : 0));
      for (let rr = 0; rr <= H; rr++)
        for (let i = 0; i < W; i++)
          mV[rr * W + i] = 0.5 * ((rr > 0 ? mass[(rr - 1) * W + i] : 0) + (rr < H ? mass[rr * W + i] : 0));
      this.faceMassOk = true;
    }
    const kv = Math.min(VISC_SCALE * Math.min(Math.max(viscosity, 0), 0.95) * dt, VISC_K_MAX);
    const kw = Math.min(VISC_SCALE * Math.min(Math.max(this.params.wallFriction, 0), 0.95) * dt, VISC_K_MAX);
    const kn = Math.min(VISC_SCALE * Math.min(Math.max(bulkViscosity, 0), 0.95) * dt, VISC_K_MAX);
    return { dt, m0, c, g, vCap, k1: Math.max(this.cohesion, 0), kv, kw, kn };
  }

  /** |u|、|v| 的最大值（力 / 新速度那一趟顺手记；多线程时各段的取最大值再给 clampPhase） */
  maxU = 0;
  maxV = 0;

  /**
   * 墙 + 速度封顶（只在主线程；之后各线程才读新速度）。
   * 速度封顶：按**矢量长度** |(u, v̄)| 封，不按分量。按分量封时斜着走的水能到 √2·vCap
   * （两个分量各顶到 vCap）：高压的水一炸开，沿轴被封在 vCap、沿对角跑到 1.41 倍 —— 摊成方形 / X。
   * 每个面用旧速度算：u 面上的 v 取周围四个 v 面的平均，v 面上的 u 同理。
   * mu / mv 是 |u|、|v| 的最大值（wallClamp 只会清零，仍是上界）：
   * max|u|² + max|v|² ≤ vCap² 时没有哪个面会超，直接跳过（绝大多数步）
   */
  clampPhase(x: StepCtx, withP: boolean, mu: number, mv: number): void {
    this.wallClamp(withP, x.dt);
    const vCap = x.vCap,
      vCap2 = vCap * vCap;
    if (mu * mu + mv * mv <= vCap2) return;
    const { u, v } = this;
    const W = this.w,
      H = this.h,
      UW = W + 1;
    const cu = this.capU,
      cv = this.capV;
    cu.set(u);
    cv.set(v);
    for (let j = 0; j < H; j++)
      for (let i = 0; i <= W; i++) {
        const e = j * UW + i;
        const a = cu[e];
        let sb = 0,
          nb = 0;
        if (i > 0) {
          sb += cv[j * W + i - 1] + cv[(j + 1) * W + i - 1];
          nb += 2;
        }
        if (i < W) {
          sb += cv[j * W + i] + cv[(j + 1) * W + i];
          nb += 2;
        }
        const b = sb / nb;
        const s2 = a * a + b * b;
        if (s2 > vCap2) u[e] = a * (vCap / Math.sqrt(s2));
      }
    for (let j = 0; j <= H; j++)
      for (let i = 0; i < W; i++) {
        const e = j * W + i;
        const b = cv[e];
        let sa = 0,
          na = 0;
        if (j > 0) {
          sa += cu[(j - 1) * UW + i] + cu[(j - 1) * UW + i + 1];
          na += 2;
        }
        if (j < H) {
          sa += cu[j * UW + i] + cu[j * UW + i + 1];
          na += 2;
        }
        const a = sa / na;
        const s2 = a * a + b * b;
        if (s2 > vCap2) v[e] = b * (vCap / Math.sqrt(s2));
      }
  }

  /** 压力（格行 j0..j1−1） */
  phasePressure(x: StepCtx, j0: number, j1: number): void {
    const { mass, kind } = this;
    const W = this.w;
    const { c, m0, k1 } = x;
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
    for (let k = j0 * W, ke = j1 * W; k < ke; k++) {
      const m = mass[k];
      if (kind[k] === CELL_WALL || m <= 0) p[k] = 0;
      else if (m0 <= 0) p[k] = c * m;
      else {
        const r = this.density(k, m);
        if (r > m0) {
          // 不满的格再乘水块面积 A：一小片很密的薄水（贴地流动时常见，A ≈ 0.05、ρ ≈ 1.3）
          // 按满格的式子推，面质量只有 m/2，加速度 2·k2·(1 − m₀/ρ) 和一整格水一样大 ——
          // 它上面那个对着空气的面被推到封顶速度，薄水"弹"起来。乘 A 后加速度随水块变小而变小；
          // A → 1（变满）时就是原来的式子，连续
          const A = m >= m0 || this.gA[k] >= 1 - 1e-9 ? 1 : this.gA[k];
          p[k] = c * A * m * (1 - m0 / r);
        } else if (k1 <= 0) p[k] = 0;
        else p[k] = Math.min(0, Math.max(-k1 * r, c * (r - m0)));
      }
    }
    // 面两侧的压差：负压（内聚）只在两侧都有水的面上起作用 —— 它是水与水之间的拉力。
    // 对着空格的那一面若也算负压，等于被真空吸住 —— 一团悬空的薄水会被吸在原地掉不下来。
    // 墙面：墙外没有水、压力按 0、质量按 0 —— 同一个式子就是"只推、不吸"
    // （墙的反作用由 wallClamp 给出：往墙里的速度清零）。写成内联，不调闭包

    // ---- 0) 速度 → 动量；1) 力；1.5) 辛欧拉 ----
    // 辛欧拉：力先加进速度，再用**新**速度挪水、平流动量。
    // 顺序是 压力(m_n) → 速度(v_n+1) → 质量(用 v_n+1) → 下一步压力(m_n+1) ……
    // 显式欧拉（用旧速度挪水）每步把压力 ↔ 质量这个振子的能量放大，网格尺度的波最先失稳 ——
    // 满屏棋盘格；硬的水（c 大）、大 dt 时整个溃坝都会越晃越厉害。辛欧拉下振子能量不涨。
    // 三件事在一趟里做完：P = m_e·v，P += 力·dt，v = P/m_e；dP 清零留给平流 / 粘性
  }

  /**
   * 力 + 辛欧拉（格行 j0..j1−1 的竖直面；水平面按面行 j0..j1−1，最后一段再加第 H 行）。
   * 只读压力、写自己这几行的面 —— 各段互不干扰
   */
  phaseForce(x: StepCtx, j0: number, j1: number): void {
    const { mass, u, v, oU, oV, mU, mV, uLo, uHi, vLo, vHi, Pu, Pv, dPu, dPv, p } = this;
    const W = this.w,
      H = this.h,
      UW = W + 1;
    const { dt, g } = x;
    let uMax = 0,
      vMax = 0;
    for (let j = j0; j < j1; j++)
      for (let i = uLo[j]; i <= uHi[j]; i++) {
        const e = j * UW + i,
          o = oU[e];
        dPu[e] = 0;
        if (o) {
          const me = mU[e];
          const qa = j * W + i - 1;
          // o = 2：左边是墙（压力 0、质量 0）；o = 3：右边是墙
          const pa = o === 2 ? 0 : p[qa],
            pb = o === 3 ? 0 : p[qa + 1];
          const dp =
            o === 1 && mass[qa] > WET && mass[qa + 1] > WET
              ? pa - pb
              : (pa > 0 ? pa : 0) - (pb > 0 ? pb : 0);
          const P = me * u[e] + dp * dt;
          Pu[e] = P;
          const x = me > EPS ? P / me : 0;
          u[e] = x;
          if (x > uMax) uMax = x;
          else if (-x > uMax) uMax = -x;
        } else {
          Pu[e] = 0;
          u[e] = 0;
        }
      }
    for (let j = j0, je = j1 === H ? H + 1 : j1; j < je; j++)
      for (let i = vLo[j]; i <= vHi[j]; i++) {
        const e = j * W + i,
          o = oV[e];
        dPv[e] = 0;
        if (o) {
          const me = mV[e];
          const qa = e - W;
          // o = 2：上面是墙；o = 3：下面是墙
          const pa = o === 2 ? 0 : p[qa],
            pb = o === 3 ? 0 : p[e];
          const dp =
            o === 1 && mass[qa] > WET && mass[e] > WET
              ? pa - pb
              : (pa > 0 ? pa : 0) - (pb > 0 ? pb : 0);
          const P = me * v[e] + (me * g + dp) * dt;
          Pv[e] = P;
          const x = me > EPS ? P / me : 0;
          v[e] = x;
          if (x > vMax) vMax = x;
          else if (-x > vMax) vMax = -x;
        } else {
          Pv[e] = 0;
          v[e] = 0;
        }
      }
    // 之后：贴墙的水不能往墙里走（墙的反作用）+ 封顶，见 clampPhase
    this.maxU = uMax;
    this.maxV = vMax;
  }

  /**
   * 第 3 步：动量平流 + 斜着那份 + 粘性（源在格行 j0..j1−1 的那些搬运）。
   * 会写到相邻一行的面（dPu / dPv）：多线程时分两色算。
   * D0..D1：这一段在 moveBlocks 里记下的斜着走的块（diagBuf 的下标范围）
   */
  phaseMomentum(x: StepCtx, j0: number, j1: number, D0: number, D1: number): void {
    const { u, v, kind, mU, mV, Pu, Pv, dPu, dPv, Fu, Fv, lU, lV, xLo, xHi, uLo, uHi, vLo, vHi } = this;
    const W = this.w,
      H = this.h,
      UW = W + 1;
    const { kv, kw, kn } = x;
    const D = this.diagBuf;

    // ---- 3) 动量平流：每处只做一次迎风搬运，通量用上面记下的真实通量 ----
    // 墙面也是一个面控制体（贴墙那半格水），和别的面一样参与搬运。动量不会穿墙：
    // 墙格里没有质量通量（Fu / Fv 在墙格旁恒为 0），经过格角的通量只剩墙这一侧的那一份。
    // 这样每个面控制体的质量变化恰好等于这些通量之和，匀速流动（包括贴着墙流）时速度不变
    // u 沿 x：经过格心
    for (let j = j0; j < j1; j++)
      for (let cc = xLo[j]; cc <= xHi[j]; cc++) {
        const a = j * UW + cc;
        const fc = 0.5 * (Fu[a] + Fu[a + 1]);
        if (fc > 0) {
          const t = fc * u[a];
          dPu[a] -= t;
          dPu[a + 1] += t;
        } else if (fc < 0) {
          const t = -fc * u[a + 1];
          dPu[a + 1] -= t;
          dPu[a] += t;
        }
      }
    // u 沿 y：经过格角，流过的质量 = 两侧竖直通量的平均（墙面 i = 0 / W 也算，域外按 0）
    for (let j = Math.max(1, j0); j < j1; j++)
      for (let i = vLo[j], ie = Math.min(W, vHi[j] + 1); i <= ie; i++) {
        const r = j * W + i;
        const fc = 0.5 * ((i > 0 ? Fv[r - 1] : 0) + (i < W ? Fv[r] : 0));
        const up = (j - 1) * UW + i,
          dn = j * UW + i;
        if (fc > 0) {
          const t = fc * u[up];
          dPu[up] -= t;
          dPu[dn] += t;
        } else if (fc < 0) {
          const t = -fc * u[dn];
          dPu[dn] -= t;
          dPu[up] += t;
        }
      }
    // v 沿 y：经过格心
    for (let cc = j0; cc < j1; cc++)
      for (let i = xLo[cc]; i <= xHi[cc]; i++) {
        const a = cc * W + i,
          b = (cc + 1) * W + i;
        const fc = 0.5 * (Fv[a] + Fv[b]);
        if (fc > 0) {
          const t = fc * v[a];
          dPv[a] -= t;
          dPv[b] += t;
        } else if (fc < 0) {
          const t = -fc * v[b];
          dPv[b] -= t;
          dPv[a] += t;
        }
      }
    // v 沿 x：经过格角，流过的质量 = 两侧水平通量的平均（墙面 j = 0 / H 也算，域外按 0）
    const jvEnd = j1 === H ? H + 1 : j1; // 水平面按面行：最后一段多管第 H 行
    for (let j = j0; j < jvEnd; j++) {
      // 上下两行竖直面范围的并集（面 i = 1..W−1）
      let lo = W,
        hi = -1;
      if (j > 0 && uHi[j - 1] >= 0) {
        lo = uLo[j - 1];
        hi = uHi[j - 1];
      }
      if (j < H && uHi[j] >= 0) {
        if (uLo[j] < lo) lo = uLo[j];
        if (uHi[j] > hi) hi = uHi[j];
      }
      for (let i = Math.max(1, lo), ie = Math.min(W - 1, hi); i <= ie; i++) {
        const r = j * UW + i;
        const fc = 0.5 * ((j > 0 ? Fu[r - UW] : 0) + (j < H ? Fu[r] : 0));
        const lf = j * W + i - 1,
          rt = j * W + i;
        if (fc > 0) {
          const t = fc * v[lf];
          dPv[lf] -= t;
          dPv[rt] += t;
        } else if (fc < 0) {
          const t = -fc * v[rt];
          dPv[rt] -= t;
          dPv[lf] += t;
        }
      }
    }

    // ---- 3.4) 斜着走的那份动量沿对角直接搬（8 方向平流）----
    // 一份水 d 从格 (i, j) 落进 (k, l)：源格四个面（左右 u、上下 v）的面质量各少 d/2，
    // 目标格四个面各多 d/2。所以每个面的动量 d/2 · (自己的速度) 直接平移 (Δi, Δj)，
    // 一步到位、不经过中间那个面（借道相邻格的话动量要在中间面上停一步，跟不上质量）
    for (let q = D0; q < D1; q += 3) {
      const s0 = D[q],
        d0 = D[q + 1],
        h = 0.5 * D[q + 2];
      const j = (s0 / W) | 0,
        i = s0 - j * W,
        l = (d0 / W) | 0,
        k = d0 - l * W;
      for (let s = 0; s <= 1; s++) {
        const ua = j * UW + i + s,
          ub = l * UW + k + s; // 左 u 面 → 左 u 面，右 → 右
        const tu = h * u[ua];
        dPu[ua] -= tu;
        dPu[ub] += tu;
        const va = (j + s) * W + i,
          vb = (l + s) * W + k; // 上 v 面 → 上，下 → 下
        const tv = h * v[va];
        dPv[va] -= tv;
        dPv[vb] += tv;
      }
    }

    // ---- 3.5) 粘性（只有侧向）：每个面只和"侧面"那个平行面交换动量 ——
    //      u 与上下的 u、v 与左右的 v。一减一加，总动量不变，只抹平层与层之间的速度差。
    //      墙当成"速度 0、质量无穷大"的水：贴墙（域边界或墙格）的面再和墙交换一份，
    //      J = k·P，这份动量被墙吸收 —— 这就是墙的摩擦，也只是侧向的。
    if (kv > 0 || kw > 0) {
      // 配对（共用一列水格才交换）、贴墙与否都是墙变了才重算的表，见 lU / lV
      for (let j = j0; j < j1; j++)
      for (let a = j * UW + uLo[j], ae = j * UW + uHi[j]; a <= ae; a++) {
        const f = lU[a];
        if (!f) continue;
        if (f & 1) {
          if (kv > 0) {
            const ma = mU[a],
              mb = mU[a + UW];
            if (ma > EPS && mb > EPS) {
              const J = kv * Math.min(ma, mb) * (u[a] - u[a + UW]);
              dPu[a] -= J;
              dPu[a + UW] += J;
            }
          }
        } else if (kw > 0 && f & 4) dPu[a] -= kw * Pu[a]; // 下面是墙
        if (kw > 0 && f & 2) dPu[a] -= kw * Pu[a]; // 上面是墙
      }
      for (let r = j0; r < jvEnd; r++)
      for (let a = r * W + vLo[r], ae = r * W + vHi[r]; a <= ae; a++) {
        const f = lV[a];
        if (!f) continue;
        if (f & 1) {
          if (kv > 0) {
            const ma = mV[a],
              mb = mV[a + 1];
            if (ma > EPS && mb > EPS) {
              const J = kv * Math.min(ma, mb) * (v[a] - v[a + 1]);
              dPv[a] -= J;
              dPv[a + 1] += J;
            }
          }
        } else if (kw > 0 && f & 4) dPv[a] -= kw * Pv[a]; // 右边是墙
        if (kw > 0 && f & 2) dPv[a] -= kw * Pv[a]; // 左边是墙
      }
    }

    // ---- 3.6) 法向（体积）粘性：u 与左右的 u、v 与上下的 v —— 管压缩 / 膨胀（∂u/∂x、∂v/∂y）。
    //      侧向粘性只抹平层与层之间的滑动，水池上下"弹"的压缩波（v 只随 y 变）它管不到，
    //      只有侧向粘性时水怎么也停不下来；变硬（elastic 大）也没用，只是波跑得更快
    if (kn > 0) {
      // 隔着一个水格的两个面（含墙面）；隔着墙格不交换
      for (let j = j0; j < j1; j++)
        for (let i = xLo[j]; i <= xHi[j]; i++) {
          const a = j * UW + i;
          if (kind[j * W + i] === CELL_WALL) continue;
          const ma = mU[a],
            mb = mU[a + 1];
          if (ma > EPS && mb > EPS) {
            const J = kn * Math.min(ma, mb) * (u[a] - u[a + 1]);
            dPu[a] -= J;
            dPu[a + 1] += J;
          }
        }
      for (let j = j0; j < j1; j++)
        for (let i = xLo[j]; i <= xHi[j]; i++) {
          const a = j * W + i;
          if (kind[a] === CELL_WALL) continue;
          const ma = mV[a],
            mb = mV[a + W];
          if (ma > EPS && mb > EPS) {
            const J = kn * Math.min(ma, mb) * (v[a] - v[a + W]);
            dPv[a] -= J;
            dPv[a + W] += J;
          }
        }
    }
  }

  /**
   * 第 5 步：动量 → 速度（新的面质量）；墙面也一样（它管贴墙那半格水）。格行 j0..j1−1。
   * 面质量和速度一趟算完：下一步开头（压力、力）用的就是这里存下的 mU / mV。
   * 范围外的面：两侧都没水，mU / mV 早就是 0（水离开时那一步的范围还包着它们）。
   * 顺手把用完的通量、newm / acc 在范围内清零（这一步所有的写都落在范围内），下一步开始时它们处处是 0。
   * newm / acc 在这里清而不在 refitBlocks 里清：refitBlocks 就可以重做（多线程时帮手卡住，协调者要能自己补算，见 parPool）
   */
  phaseVel(_x: StepCtx, j0: number, j1: number): void {
    const { mass, u, v, oU, oV, mU, mV, Pu, Pv, dPu, dPv, Fu, Fv, uLo, uHi, vLo, vHi, newm, acc, xLo, xHi } = this;
    const W = this.w,
      H = this.h,
      UW = W + 1;
    let uMax = 0,
      vMax = 0;
    for (let j = j0; j < j1; j++) {
      const r = j * W,
        e0 = j * UW;
      for (let i = uLo[j]; i <= uHi[j]; i++) {
        const e = e0 + i;
        const me = 0.5 * ((i > 0 ? mass[r + i - 1] : 0) + (i < W ? mass[r + i] : 0));
        mU[e] = me;
        const x = oU[e] && me > EPS ? (Pu[e] + dPu[e]) / me : 0;
        u[e] = x;
        if (x > uMax) uMax = x;
        else if (-x > uMax) uMax = -x;
      }
      if (uHi[j] >= uLo[j]) Fu.fill(0, e0 + uLo[j], e0 + uHi[j] + 1);
      if (xHi[j] >= xLo[j]) {
        newm.fill(0, r + xLo[j], r + xHi[j] + 1);
        acc.fill(0, (r + xLo[j]) * ACC, (r + xHi[j] + 1) * ACC);
      }
    }
    for (let rr = j0, re = j1 === H ? H + 1 : j1; rr < re; rr++) {
      const e0 = rr * W;
      for (let i = vLo[rr]; i <= vHi[rr]; i++) {
        const e = e0 + i;
        const me = 0.5 * ((rr > 0 ? mass[e - W] : 0) + (rr < H ? mass[e] : 0));
        mV[e] = me;
        const x = oV[e] && me > EPS ? (Pv[e] + dPv[e]) / me : 0;
        v[e] = x;
        if (x > vMax) vMax = x;
        else if (-x > vMax) vMax = -x;
      }
      if (vHi[rr] >= 0) Fv.fill(0, e0 + vLo[rr], e0 + vHi[rr] + 1);
    }
    this.maxU = uMax;
    this.maxV = vMax;
  }

  /**
   * 渲染用的密度：质量 / 水块面积。一条刚越过格子边界的满密度薄条（质量 0.05、密度 1）
   * 按质量画是一格很淡的水，按密度画就是和水体一样深的颜色 —— 浅淡只交给不透明度（按质量）。
   * 画笔刚改过、还没走过一步的格（质量 ≠ geoMass）水块还是旧的，按 resetGeo 的规则当成满密度
   */
  override renderDensity(): ArrayLike<number> {
    return this.renderDensityRows(0, this.h, Math.max(this.params.restDensity, 0));
  }

  /** 多线程补算（见 parPool 的 finishAlone）：挪水块的工作区整张清零（之后整张重挪） */
  clearMoveScratch(): void {
    this.newm.fill(0);
    this.acc.fill(0);
    this.Fu.fill(0);
    this.Fv.fill(0);
  }

  /** 多线程补算：动量增量整张清零（之后整张重算平流 / 粘性） */
  clearMomentumScratch(): void {
    this.dPu.fill(0);
    this.dPv.fill(0);
  }

  /**
   * 多线程补算：力那一阶段没全算完 —— 动量按现在的速度重算（算完的面已含力、没算完的面这一步少一次力），
   * 动量增量清零。只少不多：不会把力加两次
   */
  momentumFromVelocity(): void {
    const { u, v, mU, mV, Pu, Pv } = this;
    for (let e = 0; e < u.length; e++) Pu[e] = mU[e] * u[e];
    for (let e = 0; e < v.length; e++) Pv[e] = mV[e] * v[e];
    this.clearMomentumScratch();
  }

  /** 渲染用的密度数组（renderDensityRows 写的那一份；静止密度为 0 时就是质量） */
  renderRho(m0: number): ArrayLike<number> {
    return m0 <= 0 ? this.mass : this.rho;
  }

  /** 同 renderDensity，只算格行 r0..r1−1（多线程渲染时每个线程算自己那几行） */
  renderDensityRows(r0: number, r1: number, m0: number): ArrayLike<number> {
    const { mass, rho, geoMass } = this;
    if (m0 <= 0) return mass;
    for (let k = r0 * this.w, ke = r1 * this.w; k < ke; k++) {
      const m = mass[k];
      if (m <= 0) rho[k] = 0;
      else if (m !== geoMass[k]) rho[k] = m >= m0 ? m : m0;
      else rho[k] = this.density(k, m);
    }
    return rho;
  }

  /**
   * 渲染用的水块（格内坐标 0..1）：和第 2 步搬运时用的矩形完全一样（edges）。
   * 画笔刚改过、还没走过一步的格按 resetGeo：居中的正方形，边长 √(m/m₀)
   */
  override renderBlocks(): Float32Array | null {
    const { mass, blk, geoMass } = this;
    const m0 = Math.max(this.params.restDensity, 0);
    const eg = this.edgeBuf;
    for (let k = 0; k < mass.length; k++) {
      const m = mass[k],
        o = k * 4;
      if (m <= 0) {
        blk[o] = blk[o + 1] = blk[o + 2] = blk[o + 3] = 0.5;
        continue;
      }
      if (m !== geoMass[k] && m0 > 0 && m < m0) {
        // 画笔刚改过：居中的正方形，边长 √(m/m₀)
        const h = Math.sqrt(m / m0) / 2;
        blk[o] = blk[o + 2] = 0.5 - h;
        blk[o + 1] = blk[o + 3] = 0.5 + h;
        continue;
      }
      this.edges(k, m0, eg);
      blk[o] = 0.5 + eg[0];
      blk[o + 1] = 0.5 + eg[1];
      blk[o + 2] = 0.5 + eg[2];
      blk[o + 3] = 0.5 + eg[3];
    }
    return blk;
  }

  /**
   * 每行要算多少（多线程分段用）：这一步范围内的格数 + 1（空行也有一点固定开销）。
   * 在 prepare 之后调用
   */
  rowWeights(out: Float64Array): void {
    const { xLo, xHi } = this;
    for (let j = 0; j < this.h; j++) out[j] = 1 + (xHi[j] >= xLo[j] ? xHi[j] - xLo[j] + 1 : 0);
  }

  /** 鼠标指到哪一格就读哪一格（调试用；墙 / 越界返回 null） */
  probe(x: number, y: number): CellProbe | null {
    const W = this.w,
      H = this.h,
      UW = W + 1;
    if (x < 0 || y < 0 || x >= W || y >= H) return null;
    const i = y * W + x;
    if (this.kind[i] === CELL_WALL) return null;
    const p = this.p;
    const solid = (q: number) =>
      q < 0 || q >= W * H || this.kind[q] === CELL_WALL;
    const right =
      x < W - 1 && !solid(i + 1)
        ? { dp: p[i] - p[i + 1], v: this.u[y * UW + x + 1] }
        : { dp: 0, v: 0 };
    const left =
      x > 0 && !solid(i - 1)
        ? { dp: p[i] - p[i - 1], v: -this.u[y * UW + x] }
        : { dp: 0, v: 0 };
    const down =
      y < H - 1 && !solid(i + W)
        ? { dp: p[i] - p[i + W], v: this.v[(y + 1) * W + x] }
        : { dp: 0, v: 0 };
    const up =
      y > 0 && !solid(i - W)
        ? { dp: p[i] - p[i - W], v: -this.v[y * W + x] }
        : { dp: 0, v: 0 };
    return { x, y, mass: this.mass[i], pressure: p[i], right, left, down, up };
  }
}
