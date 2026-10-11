/**
 * 模拟控制器共享状态：在 React 状态与 rAF 渲染循环之间共享的可变对象。
 * UI 回调直接修改它；渲染循环每帧读取它，避免高频 setState。
 */

import { DEFAULT_PARAMS } from './engine';
import { FluidEngineSimple } from './engineSimple';
import type { PresetKey } from './presets';

export type Tool = 'liquid' | 'wall' | 'eraser' | 'source';

export const TOOLS: { key: Tool; label: string; hotkey: string }[] = [
  { key: 'liquid', label: '液体', hotkey: '1' },
  { key: 'wall', label: '墙体', hotkey: '2' },
  { key: 'eraser', label: '橡皮', hotkey: '3' },
  { key: 'source', label: '水源', hotkey: '4' },
];

/** 网格分辨率的默认值与可选范围（每边格数，方形网格） */
export const DEFAULT_GRID = 128;
export const GRID_MIN = 8;
export const GRID_MAX = 128;
export const GRID_STEP = 8;

/** 按网格边长新建一台引擎（参数用默认值；切分辨率时由 UI 覆盖成当前值） */
export function createEngine(size: number): FluidEngineSimple {
  const e = new FluidEngineSimple(size, size);
  e.params = { ...DEFAULT_PARAMS };
  return e;
}

export interface SimStats {
  fps: number;
  mass: number;
  steps: number;
  /** 底部 5 行的总质量（临时读数：排查"水瞬间到地面"） */
  floor: number;
}

/** 底部 rows 行的总质量（临时读数） */
export function floorMass(e: FluidEngineSimple, rows = 5): number {
  let s = 0;
  for (let y = Math.max(0, e.h - rows); y < e.h; y++) {
    const row = y * e.w;
    for (let x = 0; x < e.w; x++) s += e.mass[row + x];
  }
  return s;
}

export interface SimShared {
  engine: FluidEngineSimple;
  running: boolean;
  /** 每帧模拟时间预算的倍率（0.25~1）：1× = 用满一帧（60fps 的 16.7ms），即不掉帧前提下的最快 */
  speed: number;
  tool: Tool;
  brushSize: number;
  /** 暂停时绘制后需要补渲一帧 */
  needsRedraw: boolean;
  /** 场景切换计数（触发闪白动画） */
  loadNonce: number;
  stats: SimStats;
}

export function createSimShared(): SimShared {
  // 试验：换上「只按自身质量施压」的新引擎。回退只需把下面这行改回 new FluidEngine(...)
  const engine = createEngine(DEFAULT_GRID);
  return {
    engine,
    running: true,
    speed: 1,
    tool: 'liquid',
    brushSize: 4,
    needsRedraw: true,
    loadNonce: 0,
    stats: { fps: 0, mass: 0, steps: 0, floor: 0 },
  };
}

export function applyBrush(shared: SimShared, gx: number, gy: number, tool: Tool): void {
  const e = shared.engine;
  const r = shared.brushSize / 2;
  switch (tool) {
    case 'liquid':
      e.paintLiquid(gx, gy, r);
      break;
    case 'wall':
      e.paintWall(gx, gy, r);
      break;
    case 'eraser':
      e.paintErase(gx, gy, r);
      break;
    case 'source':
      e.paintSource(gx, gy, r);
      break;
  }
  shared.needsRedraw = true;
}

export function currentPresetDefault(): PresetKey {
  return 'dam';
}
