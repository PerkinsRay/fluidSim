/**
 * 渲染管线：密度 → 颜色（HSL 插值）× 不透明度 → ImageData 像素直写。
 * 色阶：空格为背景色 #0A101C；液体为单一蓝色系，#BFDBFE(稀薄) → #1E3A8A(浓稠)。
 * 颜色随密度**连续加深**（对数曲线，DENSITY_DEEP 之上才到最深色）；
 * 蓝色阶段一律不透明，只有稀到发白（ALPHA_OPAQUE_FROM 以下）才按平方渐透，
 * 越稀越透，最后溶进画布背景（#0A101C）。
 */

import { CELL, RENDER_EMPTY_EPS, FluidEngine } from './engine';
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
  else [r, g, b] = [c, 0, x];
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
const ALPHA_MIN = 0.05;
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
  const { w, h, mass, wall } = engine;
  const pw = w * CELL;

  let px = pixelCache.get(image);
  if (!px) {
    px = new Uint32Array(image.data.buffer, image.data.byteOffset, image.data.length / 4);
    pixelCache.set(image, px);
  }

  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      const p0 = y * CELL * pw + x * CELL; // 本格左上角像素下标

      if (wall[i]) {
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

      const s = mass[i];
      const color =
        s <= RENDER_EMPTY_EPS
          ? EMPTY32
          : LUT32[Math.floor(densityLevel(s) * 255) * ALPHA_LEVELS + alphaLevel(s)];

      // 填充 CELL×CELL 块（逐行 fill）
      for (let dy = 0; dy < CELL; dy++) {
        const p = p0 + dy * pw;
        px.fill(color, p, p + CELL);
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
  const { w, h, wall, source } = engine;

  // 水源格：脉动青色圆点（叠加在像素画面上）
  const pulse = 0.55 + 0.45 * Math.sin(timeMs / 300);
  ctx.fillStyle = `rgba(103, 232, 249, ${0.5 + 0.4 * pulse})`;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      if (source[i] && !wall[i]) {
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
    if (engine.wall[i]) {
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
