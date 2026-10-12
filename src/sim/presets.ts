/**
 * 场景预设：在引擎中预置墙体与液体的演示布局。
 */

import { FluidEngine, CELL_WALL, CELL_SOURCE } from './engine';

export type PresetKey = 'blank' | 'dam' | 'twin' | 'rain' | 'hourglass';

export interface PresetMeta {
  key: PresetKey;
  label: string;
}

export const PRESETS: PresetMeta[] = [
  { key: 'blank', label: '空白画布' },
  { key: 'dam', label: '水坝溃决' },
  { key: 'twin', label: '双箱连通' },
  { key: 'rain', label: '倾盆之雨' },
  { key: 'hourglass', label: '沙漏' },
];

function fillRect(e: FluidEngine, x0: number, y0: number, x1: number, y1: number, fn: (i: number) => void) {
  for (let y = Math.max(0, y0); y <= Math.min(e.h - 1, y1); y++) {
    for (let x = Math.max(0, x0); x <= Math.min(e.w - 1, x1); x++) {
      fn(y * e.w + x);
    }
  }
}

function wallRect(e: FluidEngine, x0: number, y0: number, x1: number, y1: number) {
  fillRect(e, x0, y0, x1, y1, (i) => {
    e.kind[i] = CELL_WALL;
    e.mass[i] = 0;
  });
}

/** 液体按静止密度 m₀ 填入：高于 m₀ 的部分会在第 0 步被压力弹开（c 大时表现为炸开） */
function liquidRect(e: FluidEngine, x0: number, y0: number, x1: number, y1: number, amount = Math.max(e.params.restDensity, 0.1)) {
  fillRect(e, x0, y0, x1, y1, (i) => {
    if (e.kind[i] !== CELL_WALL) e.mass[i] = amount;
  });
}

/** 底部地板，所有演示场景共用 */
function floor(e: FluidEngine) {
  wallRect(e, 0, e.h - 2, e.w - 1, e.h - 1);
}

/** 水坝溃决：左侧高水位水体被一道竖直坝体挡住，坝底留一个缺口 */
function dam(e: FluidEngine) {
  floor(e);
  const damX = Math.floor(e.w * 0.38);
  // 坝体（底部 6 格留出缺口）
  wallRect(e, damX, Math.floor(e.h * 0.25), damX + 1, e.h - 9);
  // 库区水体
  liquidRect(e, 3, Math.floor(e.h * 0.3), damX - 2, e.h - 4);
  // 左侧挡墙
  wallRect(e, 0, Math.floor(e.h * 0.25), 1, e.h - 3);
}

/** 双箱连通：两个箱体，左箱满水右箱空，隔板下方有连通口 */
function twin(e: FluidEngine) {
  floor(e);
  const mid = Math.floor(e.w / 2);
  const top = Math.floor(e.h * 0.35);
  // 外壁
  wallRect(e, 2, top, 3, e.h - 3);
  wallRect(e, e.w - 4, top, e.w - 3, e.h - 3);
  // 中间隔板（底部留 4 格连通口）
  wallRect(e, mid, top, mid + 1, e.h - 7);
  // 左箱水体
  liquidRect(e, 4, top + 2, mid - 1, e.h - 4);
}

/** 倾盆之雨：顶部一排水源，下方若干障碍平台 */
function rain(e: FluidEngine) {
  floor(e);
  const { w, h } = e;
  // 顶部水源带
  for (let x = Math.floor(w * 0.15); x <= Math.floor(w * 0.85); x += 2) {
    const i = 2 * w + x;
    if (e.kind[i] !== CELL_WALL) e.kind[i] = CELL_SOURCE;
  }
  // 障碍平台
  wallRect(e, Math.floor(w * 0.2), Math.floor(h * 0.45), Math.floor(w * 0.42), Math.floor(h * 0.45) + 1);
  wallRect(e, Math.floor(w * 0.58), Math.floor(h * 0.6), Math.floor(w * 0.8), Math.floor(h * 0.6) + 1);
  wallRect(e, Math.floor(w * 0.3), Math.floor(h * 0.78), Math.floor(w * 0.55), Math.floor(h * 0.78) + 1);
}

/** 沙漏：上下两个锥形容器，液体从上容器经窄口滴入下容器 */
function hourglass(e: FluidEngine) {
  const { w, h } = e;
  const mid = Math.floor(w / 2);
  const midY = Math.floor(h * 0.52);
  // 上容器漏斗壁（斜边用阶梯近似）
  const halfTop = Math.floor(w * 0.22);
  for (let i = 0; i < halfTop; i++) {
    const y = Math.floor(h * 0.12) + Math.floor((i / halfTop) * (midY - Math.floor(h * 0.12) - 2));
    wallRect(e, mid - halfTop + i - 1, y, mid - halfTop + i, y + 1);
    wallRect(e, mid + halfTop - i, y, mid + halfTop - i + 1, y + 1);
  }
  // 窄口两侧挡块（留 2 格口）
  wallRect(e, mid - halfTop - 1, midY - 2, mid - 2, midY - 1);
  wallRect(e, mid + 2, midY - 2, mid + halfTop + 1, midY - 1);
  // 上容器侧壁
  wallRect(e, mid - halfTop - 2, Math.floor(h * 0.08), mid - halfTop - 1, Math.floor(h * 0.2));
  wallRect(e, mid + halfTop + 1, Math.floor(h * 0.08), mid + halfTop + 2, Math.floor(h * 0.2));
  // 上容器中的液体
  liquidRect(e, mid - halfTop + 2, Math.floor(h * 0.12), mid + halfTop - 2, Math.floor(h * 0.3));
  // 下容器
  const y0 = Math.floor(h * 0.72);
  wallRect(e, mid - halfTop - 2, y0, mid - halfTop - 1, h - 3);
  wallRect(e, mid + halfTop + 1, y0, mid + halfTop + 2, h - 3);
  wallRect(e, mid - halfTop - 2, h - 3, mid + halfTop + 2, h - 1);
}

/** 将预设应用到引擎（先清空） */
export function applyPreset(engine: FluidEngine, key: PresetKey): void {
  engine.clear();
  switch (key) {
    case 'blank':
      break;
    case 'dam':
      dam(engine);
      break;
    case 'twin':
      twin(engine);
      break;
    case 'rain':
      rain(engine);
      break;
    case 'hourglass':
      hourglass(engine);
      break;
  }
}
