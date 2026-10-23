/**
 * PLIC（Piecewise Linear Interface Calculation）界面重建 —— 引擎与渲染共用。
 *
 * 界面格（0 < m < m₀）里的水不是"整格半密度"，而是**满密度的水占了格子的一部分**。
 * PLIC 假设这一部分是一条直线切出来的：液区 = {n·X ≤ α} ∩ 单位方格，
 * 其中法向 n 由邻格体积分数的中心差分（Youngs）给出，α 由"截断体积 = f"反解。
 *
 * 两个用途：
 *   - 引擎：边上流出时，扫过的那条窄带里真正是液体的比例（stripFrac）；
 *   - 渲染：逐像素判断落在界面的哪一侧，于是画出一条**直的界面线**而不是糊开的渐变。
 */
import { CELL_WALL } from "./engine";

/** 法向退化（邻格给不出梯度）时的阈值 */
const EPS = 1e-9;

/**
 * 单位方格的截断体积：液区 {a·u + b·v ≤ α}（a, b ≥ 0）占方格的面积分数，闭式解。
 * 三段分支分别对应"切掉一个角 / 切成梯形 / 只剩一个角是干的"。
 */
export function vol(a: number, b: number, alpha: number): number {
  if (alpha <= 0) return 0;
  const ab = a + b;
  if (alpha >= ab) return 1;
  if (a < EPS || b < EPS) return alpha / ab; // 法向退化成轴向：线性
  const m = a < b ? a : b;
  const M = a < b ? b : a;
  if (alpha <= m) return (alpha * alpha) / (2 * a * b);
  if (alpha >= M) return 1 - ((ab - alpha) * (ab - alpha)) / (2 * a * b);
  return (alpha - m / 2) / M;
}

/** vol 的逆：由体积分数 f 反解 α（三段各自求逆，分界处连续） */
export function invVol(a: number, b: number, f: number): number {
  if (f <= 0) return 0;
  const ab = a + b;
  if (f >= 1) return ab;
  if (a < EPS || b < EPS) return f * ab;
  const m = a < b ? a : b;
  const M = a < b ? b : a;
  const f1 = (m * m) / (2 * a * b); // α = m 处的体积
  if (f <= f1) return Math.sqrt(2 * a * b * f);
  const f2 = 1 - f1; // α = M 处的体积（对称）
  if (f >= f2) return ab - Math.sqrt(2 * a * b * (1 - f));
  return f * M + m / 2;
}

/**
 * 一个界面格的重建结果。
 * 液区在**反射坐标**里是 {a·u' + b·v' ≤ alpha}，其中
 *   u' = nxPos ? u : 1 − u，v' = nyPos ? v : 1 − v，u, v ∈ [0,1] 是格内归一化坐标（v 向下）。
 * 反射的作用是把法向掰到第一象限，于是只需要一套闭式解。
 */
export interface Interface {
  /** 法向分量的绝对值（已归一到 a + b 的尺度上，只有比例有意义） */
  a: number;
  b: number;
  /** 截断参数 */
  alpha: number;
  /** 法向分量是否为正（决定坐标是否反射） */
  nxPos: boolean;
  nyPos: boolean;
  /** 邻格给不出法向时为 false —— 此时没有可画的界面线，调用方按整格均匀处理 */
  ok: boolean;
}

const DEGENERATE: Interface = {
  a: 0,
  b: 0,
  alpha: 0,
  nxPos: true,
  nyPos: true,
  ok: false,
};

/**
 * 重建格 i 的界面。
 * 法向取 n = −∇f（指向液体少的一侧），于是液区落在 {n·X ≤ α} 的低侧；
 * 墙与越界的邻格按**本格**的 f 计（等价于单侧差分，不会让界面莫名贴着墙弯）。
 */
export function reconstruct(
  mass: Float32Array,
  kind: Uint8Array,
  w: number,
  h: number,
  i: number,
  m0: number,
): Interface {
  const fc = Math.min(1, mass[i] / m0);
  if (fc <= 0 || fc >= 1) return DEGENERATE;
  const x = i % w;
  const y = (i - x) / w;
  // 邻格体积分数；墙 / 越界回落到本格
  const sample = (xx: number, yy: number): number => {
    if (xx < 0 || yy < 0 || xx >= w || yy >= h) return fc;
    const j = yy * w + xx;
    return kind[j] === CELL_WALL ? fc : Math.min(1, mass[j] / m0);
  };
  const fL = sample(x - 1, y);
  const fR = sample(x + 1, y);
  const fU = sample(x, y - 1);
  const fD = sample(x, y + 1);
  const nx = 0.5 * (fL - fR); // −∂f/∂x
  const ny = 0.5 * (fU - fD); // −∂f/∂y（y 向下）
  const a = Math.abs(nx);
  const b = Math.abs(ny);
  if (a < EPS && b < EPS) return DEGENERATE; // 四邻一样：没有方向信息
  return {
    a,
    b,
    alpha: invVol(a, b, fc),
    nxPos: nx >= 0,
    nyPos: ny >= 0,
    ok: true,
  };
}

/**
 * 流出时扫过的窄带里**液体的比例**（0..1，相对窄带自身的面积）。
 * dir：0 右 / 1 下 / 2 左 / 3 上；delta：窄带宽度（格宽的分数，0..1）。
 *
 * 把窄带那一段坐标线性映射回单位方格，再套同一个闭式解即可：
 * 窄带贴在反射坐标的高侧时 u' ∈ [1−δ, 1] ⇒ vol(a·δ, b, α − a(1−δ))，
 * 贴在低侧时 u' ∈ [0, δ] ⇒ vol(a·δ, b, α)。
 */
export function stripFrac(
  rec: Interface,
  dir: number,
  delta: number,
): number {
  if (!rec.ok) return -1; // 调用方自行回落
  const { a, b, alpha, nxPos, nyPos } = rec;
  if (delta <= 0) return 0;
  const d = delta > 1 ? 1 : delta;
  if (dir === 0 || dir === 2) {
    // 真实右侧（dir 0）在反射坐标里是否仍是高侧，取决于有没有反射
    const high = dir === 0 ? nxPos : !nxPos;
    return vol(a * d, b, high ? alpha - a * (1 - d) : alpha);
  }
  const high = dir === 1 ? nyPos : !nyPos;
  return vol(a, b * d, high ? alpha - b * (1 - d) : alpha);
}

/**
 * 格 i 紧贴 dir 那个面的一条带里的**液体质量**（带宽 delta，格宽的分数）。
 * dir：0 右 / 1 下 / 2 左 / 3 上。
 *
 * 用来回答"这一格的水有多少真的压在这个面上"。界面格里的水只占格子的一部分，
 * 贴着上半格的水并没有压在下面那个面上 —— 整格质量 m_i 会高估它。
 * 均匀满格时结果恰好是 delta·m_i，所以拿它做上限不会动到满格的行为。
 *
 * 压缩格（m > m₀）按整格均匀处理：PLIC 只描述"液体占多少格"，m₀ 以上的那部分
 * 是被压缩的液体，充满整格。
 */
export function bandMass(
  mass: Float32Array,
  kind: Uint8Array,
  w: number,
  h: number,
  i: number,
  dir: number,
  delta: number,
  m0: number,
): number {
  const m = mass[i];
  if (m <= 0) return 0;
  const d = delta <= 0 ? 0 : delta > 1 ? 1 : delta;
  if (m >= m0) return m * d; // 满格 / 压缩格：液体充满整格，带里就是 delta 份
  const rec = reconstruct(mass, kind, w, h, i, m0);
  const s = stripFrac(rec, dir, d);
  if (s < 0) return m * d; // 法向退化：按整格均匀
  // s 是"带里液体占带面积的比例"，带面积 = d（格面积为 1），液体面积 = s·d，
  // 对应质量 s·d·m₀。但这份液体不能超过本格**真正有的**质量 m ——
  // 否则极稀薄的格会凭空多出水：实测 f = 0.02 的格 s·d·m₀ 比真实通量大 50 倍，
  // 自由落体因此变成与密度有关（m1 = 26.59 而 m0.03 = 74.00），还会压出负质量。
  const liquid = s * d * m0;
  return liquid > m ? m : liquid;
}

/**
 * 界面格的通量修正系数 φ = stripFrac / f。
 *
 * 为什么是**比值**而不是 stripFrac 本身：引擎原本的通量 dm = dt·P = dt·u·m_e 里
 * 已经含了一次格平均分数 f（m_e ≈ m₀·f），相当于默认"液体均匀摊在整格"。
 * PLIC 要做的是把这个 f 换成"窄带里的真实比例"，所以乘 stripFrac/f。
 *
 * 直接乘 stripFrac 会把 f 算两遍 —— 这正是上一次 PLIC 把自由落体从 32 格打到 3 格的原因：
 * 孤立水团四邻全空、法向退化，stripFrac 只能取 f，于是每步通量被白白再砍一半。
 * 现在退化时返回 1（不修正），而界面陡峭时 stripFrac → 1、φ → 1/f > 1，界面被**锐化**。
 *
 * 【只锐化，不饿死】φ 还要夹在 ≥ 1。原因是重建每步都从邻格重新算：下落水团的下沿格
 * 法向总是指向团内（液体在上半格），于是"往下那条窄带"里重建出来的液体恒为 0，
 * 顺流通量被判死刑 —— 水团再也掉不下去（实测自由落体 32 → 6.95，而且随密度变化，
 * m0.5 只有 5.01，这是物理上不允许的：自由落体与密度无关）。
 * 真正的 VOF 要靠**追踪界面位置**才能让这份液体逐步越过边界，本引擎没有那套状态，
 * 所以这里只取 PLIC 的"锐化"那一半：窄带里液体比平均多 ⇒ 多搬（界面保持一格宽）；
 * 比平均少 ⇒ 照常搬（不扣），把守恒与自由落体让给物理正确性。
 */
export function fluxRatio(
  mass: Float32Array,
  kind: Uint8Array,
  w: number,
  h: number,
  donor: number,
  dir: number,
  delta: number,
  m0: number,
  maxRatio: number,
): number {
  const f = mass[donor] / m0;
  if (f <= 0 || f >= 1) return 1; // 空格 / 满格：没有界面
  const rec = reconstruct(mass, kind, w, h, donor, m0);
  const s = stripFrac(rec, dir, delta);
  if (s < 0) return 1; // 法向退化：不修正
  const r = s / f;
  if (r <= 1) return 1; // 只锐化、不饿死（见上方说明）
  return r > maxRatio ? maxRatio : r;
}
