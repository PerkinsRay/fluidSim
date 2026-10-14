/**
 * 渲染管线：密度 → 颜色（HSL 插值）× 不透明度 → ImageData 像素直写。
 * 色阶：空格为背景色 #0A101C；液体为单一蓝色系，#BFDBFE(稀薄) → #1E3A8A(浓稠)。
 * 颜色随密度**连续加深**（对数曲线，DENSITY_DEEP 之上才到最深色）；
 * 蓝色阶段一律不透明，只有稀到发白（ALPHA_OPAQUE_FROM 以下）才按平方渐透，
 * 越稀越透，最后溶进画布背景（#0A101C）。
 */

import { RENDER_EMPTY_EPS, FluidEngine, CELL_WALL, CELL_SOURCE } from './engine';
import { applyPreset } from './presets';
import type { PresetKey } from './presets';

interface HSL {
  h: number;
  s: number;
  l: number;
}

function hexToHsl(hex: string): HSL {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  return { h: h * 360, s, l };
}

function hslToRgb({ h, s, l }: HSL): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else[r, g, b] = [c, 0, x];
  const m = l - c / 2;
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/**
 * 密度色阶锚点（HSL 连续插值）：单一蓝色系，颜色越深密度越大。
 * 稀薄 = 浅蓝 → 浓稠 = 深蓝。任何有液体的格都显示为蓝色，不会与空格背景混淆。
 */
const STOPS = ['#BFDBFE', '#60A5FA', '#2563EB', '#1D4ED8', '#1E3A8A'].map(hexToHsl);

// ---- 密度 → 颜色（连续加深，不封顶）----
/** 达到最深色的密度：之前一路连续加深，不会提前撞到最深色 */
const DENSITY_DEEP = 3.5;
/** 对数曲线拐点：小密度也留一点颜色，薄水不至于看不见 */
const DENSITY_KNEE = 0.5;
const DENSITY_LOG = Math.log(1 + DENSITY_DEEP / DENSITY_KNEE);

/** 质量 → 色阶参数 t ∈ [0,1]（连续、单调） */
function densityLevel(m: number): number {
  return Math.min(1, Math.log(1 + m / DENSITY_KNEE) / DENSITY_LOG);
}

// ---- 密度 → 不透明度（蓝色阶段一律不透明，稀到发白才渐透）----
/** 达到完全不透明的密度：由此往上（蓝色阶段）都是不透明的 */
const ALPHA_OPAQUE_FROM = 0.4;
/** 最稀薄处的不透明度：几乎溶进背景 */
const ALPHA_MIN = 0.01;
/** 不透明度分级数（做成二维 LUT，热路径上不用每格做乘法） */
const ALPHA_LEVELS = 256;

/** 质量 → 不透明度等级 a ∈ [0, ALPHA_LEVELS-1]：ALPHA_OPAQUE_FROM 之上拉满，之下按平方衰减 */
function alphaLevel(m: number): number {
  const x = Math.min(1, m / ALPHA_OPAQUE_FROM);
  return Math.min(ALPHA_LEVELS - 1, Math.floor(x * x * (ALPHA_LEVELS - 1)));
}

/** 不透明度等级 → 实际不透明度（ALPHA_MIN … 1） */
function alphaFromLevel(a: number): number {
  return ALPHA_MIN + (1 - ALPHA_MIN) * (a / (ALPHA_LEVELS - 1));
}

/** 预计算 LUT，避免每像素重复插值 */
const LUT = new Uint8Array(256 * 3);
for (let n = 0; n < 256; n++) {
  const t = n / 255;
  const scaled = t * (STOPS.length - 1);
  const idx = Math.min(Math.floor(scaled), STOPS.length - 2);
  const frac = scaled - idx;
  const a = STOPS[idx];
  const b = STOPS[idx + 1];
  const hsl: HSL = {
    h: a.h + (b.h - a.h) * frac,
    s: a.s + (b.s - a.s) * frac,
    l: a.l + (b.l - a.l) * frac,
  };
  const [r, g, bl] = hslToRgb(hsl);
  LUT[n * 3] = r;
  LUT[n * 3 + 1] = g;
  LUT[n * 3 + 2] = bl;
}

const EMPTY_RGB: [number, number, number] = [0x0a, 0x10, 0x1c];
const WALL_RGB: [number, number, number] = [0x64, 0x74, 0x8b];
const WALL_EDGE_RGB: [number, number, number] = [0x41, 0x51, 0x66];

// ---- 32 位像素打包：一次写入整个 RGBA 像素，并可用 fill 整行填充 ----
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

function pack(r: number, g: number, b: number, a = 255): number {
  return LITTLE_ENDIAN
    ? ((a << 24) | (b << 16) | (g << 8) | r) >>> 0
    : ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
}

/** 色阶 × 不透明度 的二维 LUT：LUT32[色阶 * ALPHA_LEVELS + 透明度等级] */
const LUT32 = new Uint32Array(256 * ALPHA_LEVELS);
for (let n = 0; n < 256; n++) {
  for (let a = 0; a < ALPHA_LEVELS; a++) {
    LUT32[n * ALPHA_LEVELS + a] = pack(
      LUT[n * 3],
      LUT[n * 3 + 1],
      LUT[n * 3 + 2],
      Math.round(alphaFromLevel(a) * 255),
    );
  }
}
const EMPTY32 = pack(...EMPTY_RGB);
const WALL32 = pack(...WALL_RGB);
const WALL_EDGE32 = pack(...WALL_EDGE_RGB);

/**
 * 质量 → 像素 的一维 LUT（渐变渲染用）。
 * 渐变后每个**像素**都有自己的插值密度，不能再每像素算一次 log 和乘方 —— 预先量化查表。
 * 上界取 DENSITY_DEEP：之上颜色与不透明度都已饱和，不必再细分。
 */
const MASS_LUT_N = 1024;
const MASS_LUT_MAX = DENSITY_DEEP;
const MASS_LUT_SCALE = (MASS_LUT_N - 1) / MASS_LUT_MAX;
const MASS32 = new Uint32Array(MASS_LUT_N);
for (let n = 0; n < MASS_LUT_N; n++) {
  const m = (n / (MASS_LUT_N - 1)) * MASS_LUT_MAX;
  MASS32[n] = LUT32[Math.floor(densityLevel(m) * 255) * ALPHA_LEVELS + alphaLevel(m)];
}

/**
 * 像素在格内的插值权重（只依赖 CELL，按 CELL 缓存一份）。
 * w[d] = 偏向邻格的权重，neg[d] = 偏向的是上/左那一侧。
 * 取 (d+0.5)/CELL − 0.5 是像素中心在"格心坐标系"里的偏移，于是相邻两格的边缘像素
 * 正好接上（权重差恰为一个像素步长 1/CELL），跨格边界不会出现台阶。
 */
const fracCache = new Map<number, { w: Float32Array; neg: Uint8Array }>();
function fracFor(cell: number): { w: Float32Array; neg: Uint8Array } {
  let f = fracCache.get(cell);
  if (!f) {
    const w = new Float32Array(cell);
    const neg = new Uint8Array(cell);
    for (let d = 0; d < cell; d++) {
      const u = (d + 0.5) / cell - 0.5;
      w[d] = Math.abs(u);
      neg[d] = u < 0 ? 1 : 0;
    }
    f = { w, neg };
    fracCache.set(cell, f);
  }
  return f;
}

/** 每个 ImageData 的 32 位视图 */
const pixelCache = new WeakMap<ImageData, Uint32Array>();

/**
 * 将模拟状态写入 ImageData 并绘制到 canvas。
 * 每格 CELL×CELL 像素；墙体带 1px 深色内描边；水源格叠加脉动青色亮点。
 */
export function renderEngine(
  engine: FluidEngine,
  ctx: CanvasRenderingContext2D,
  image: ImageData,
  timeMs: number,
): void {
  const { w, h, mass, kind } = engine;
  const CELL = engine.cell; // 每格几个像素：由画布内部渲染尺寸反推，见 engine.ts
  const pw = w * CELL;

  let px = pixelCache.get(image);
  if (!px) {
    px = new Uint32Array(image.data.buffer, image.data.byteOffset, image.data.length / 4);
    pixelCache.set(image, px);
  }

  const { w: fw, neg: fneg } = fracFor(CELL);
  const HALF = CELL >> 1; // 偏左 / 偏上的那一半像素（CELL 为奇数时中间那列权重为 0，归哪半都一样）

  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      const p0 = y * CELL * pw + x * CELL; // 本格左上角像素下标

      if (kind[i] === CELL_WALL) {
        // 墙体 1px 内描边（砌块感）：首尾两行为描边色，中间行左右各 1px 描边
        px.fill(WALL_EDGE32, p0, p0 + CELL);
        for (let dy = 1; dy < CELL - 1; dy++) {
          const p = p0 + dy * pw;
          px[p] = WALL_EDGE32;
          px.fill(WALL32, p + 1, p + CELL - 1);
          px[p + CELL - 1] = WALL_EDGE32;
        }
        const pLast = p0 + (CELL - 1) * pw;
        px.fill(WALL_EDGE32, pLast, pLast + CELL);
        continue;
      }

      const mC = mass[i];

      // 3×3 邻域采样：格心保留本格真实密度，格内像素在最近四个格心之间双线性插值，
      // 于是一格的颜色向周围 8 格连续渐变（实测跨格色阶 ≤ 3.9/255）。
      // 墙 / 越界按本格算，否则水贴着墙会渐隐出一道暗边；空格保留真实的 0，
      // 水的边缘才会柔和地化进背景。水与墙之间仍是硬边 —— 那是应该的。
      const xm = x > 0 ? x - 1 : x;
      const xp = x < w - 1 ? x + 1 : x;
      const ym = y > 0 ? y - 1 : y;
      const yp = y < h - 1 ? y + 1 : y;
      const rm = ym * w;
      const rp = yp * w;
      const sL = kind[row + xm] === CELL_WALL ? mC : mass[row + xm];
      const sR = kind[row + xp] === CELL_WALL ? mC : mass[row + xp];
      const sU = kind[rm + x] === CELL_WALL ? mC : mass[rm + x];
      const sD = kind[rp + x] === CELL_WALL ? mC : mass[rp + x];
      const sLU = kind[rm + xm] === CELL_WALL ? mC : mass[rm + xm];
      const sRU = kind[rm + xp] === CELL_WALL ? mC : mass[rm + xp];
      const sLD = kind[rp + xm] === CELL_WALL ? mC : mass[rp + xm];
      const sRD = kind[rp + xp] === CELL_WALL ? mC : mass[rp + xp];

      // 快路：整个邻域都是空的 → 本格不可能插出颜色，整块 fill（memset 级，远快于逐像素）。
      // 空气往往占画面一大半，这一条把渐变的代价基本压回原来的水平。
      if (
        mC <= RENDER_EMPTY_EPS &&
        sL <= RENDER_EMPTY_EPS &&
        sR <= RENDER_EMPTY_EPS &&
        sU <= RENDER_EMPTY_EPS &&
        sD <= RENDER_EMPTY_EPS &&
        sLU <= RENDER_EMPTY_EPS &&
        sRU <= RENDER_EMPTY_EPS &&
        sLD <= RENDER_EMPTY_EPS &&
        sRD <= RENDER_EMPTY_EPS
      ) {
        for (let dy = 0; dy < CELL; dy++) {
          const p = p0 + dy * pw;
          px.fill(EMPTY32, p, p + CELL);
        }
        continue;
      }

      for (let dy = 0; dy < CELL; dy++) {
        const wy = fw[dy];
        const up = fneg[dy] === 1;
        const mV = up ? sU : sD;
        const p = p0 + dy * pw;
        // 双线性对固定的一组角点可整理成 m = base + wx·slope，内层只剩一次乘加。
        // 左右半格的横向邻格不同，所以拆成两段，省掉逐像素的分支。
        const byY = mC + wy * (mV - mC);
        for (let half = 0; half < 2; half++) {
          const mH = half === 0 ? sL : sR;
          const mHV = half === 0 ? (up ? sLU : sLD) : up ? sRU : sRD;
          const slope = mH - mC + wy * (mHV - mH - mV + mC);
          const d0 = half === 0 ? 0 : HALF;
          const d1 = half === 0 ? HALF : CELL;
          for (let dx = d0; dx < d1; dx++) {
            const m = byY + fw[dx] * slope;
            px[p + dx] =
              m <= RENDER_EMPTY_EPS
                ? EMPTY32
                : MASS32[m >= MASS_LUT_MAX ? MASS_LUT_N - 1 : (m * MASS_LUT_SCALE) | 0];
          }
        }
      }
    }
  }

  ctx.putImageData(image, 0, 0);

  drawSources(engine, ctx, timeMs);
}

/** 水源格：脉动青色圆点（叠加在像素画面上） */
function drawSources(
  engine: FluidEngine,
  ctx: CanvasRenderingContext2D,
  timeMs: number,
): void {
  const { w, h, kind } = engine;
  const CELL = engine.cell;

  // 水源格：脉动青色圆点（叠加在像素画面上）
  const pulse = 0.55 + 0.45 * Math.sin(timeMs / 300);
  ctx.fillStyle = `rgba(103, 232, 249, ${0.5 + 0.4 * pulse})`;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      if (kind[i] === CELL_SOURCE) {
        const cx = x * CELL + CELL / 2;
        const cy = y * CELL + CELL / 2;
        ctx.beginPath();
        ctx.arc(cx, cy, 1.6 + pulse, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}

/**
 * 生成一幅迷你预览帧（供 Hero 静态预览画布）：
 * 新建一个小网格引擎，载入预设并推进若干步，返回 1 像素/格的 ImageData。
 * 渲染管线与主画布一致（同一密度色阶 LUT）。
 */
export function makePreviewFrame(preset: PresetKey, w = 48, h = 48, steps = 600): ImageData {
  const engine = new FluidEngine(w, h);
  applyPreset(engine, preset);
  for (let s = 0; s < steps; s++) engine.step();

  const image = new ImageData(w, h);
  const data = image.data;
  for (let i = 0; i < w * h; i++) {
    let r: number;
    let g: number;
    let b: number;
    let alpha = 255;
    if (engine.kind[i] === CELL_WALL) {
      r = WALL_RGB[0];
      g = WALL_RGB[1];
      b = WALL_RGB[2];
    } else {
      const m = engine.mass[i];
      if (m <= RENDER_EMPTY_EPS) {
        r = EMPTY_RGB[0];
        g = EMPTY_RGB[1];
        b = EMPTY_RGB[2];
      } else {
        const t = Math.floor(densityLevel(m) * 255);
        r = LUT[t * 3];
        g = LUT[t * 3 + 1];
        b = LUT[t * 3 + 2];
        alpha = Math.round(alphaFromLevel(alphaLevel(m)) * 255);
      }
    }
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = alpha;
  }
  return image;
}
