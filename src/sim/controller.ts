/**
 * 模拟控制器共享状态：在 React 状态与 rAF 渲染循环之间共享的可变对象。
 * UI 回调直接修改它；渲染循环每帧读取它，避免高频 setState。
 */

import { DEFAULT_PARAMS } from "./engine";
// 换引擎只改下面这一行的 import：
//   FluidEngineBlob   = 边速度 + 每格水块追踪（当前）—— 修一阶迎风的数值扩散：
//                       水块没真的走到格子边，下一格就拿不到水。shape 可切 'rect' / 'offset' / 'blob'。
//                       一格水下落 400 步仍是 1 格（engineSimple 铺成 17 格），方块平移精确。
//   FluidEngineMix    = 边速度 / 质量加权混合平流 —— 速度是一等状态量，全程不做
//                       u = P/m_e 的换算，所以质量变化不会反过来改速度。
//                       剪切 −6.7e-4、45° 9.0/9.0（精确）、镜像 3.0e-3、尾迹 41 行；
//                       代价是 dam 闪 0.385（原版 0.091）。
//   FluidEngineFlux   = 边速度 / 散射平流 + 重力冲量（当前；剪切 1.2e-3、镜像 3.1e-3，
//                       dam 闪 0.129，但尾迹 92 行最长）
//   FluidEngineSimple = 边动量 / 守恒动量平流（原版；dam 闪 0.091、尾迹 56 行）
//   FluidEngineVel    = 边速度 / 与 engineSimple **逐项等价**（实测差 1e-7，可无感替换）
//   FluidEngineAvg    = 边速度 / 非守恒平流 / 平均质量（对称性最好，但落体慢 14%、闪烁高一倍）
//   FluidEngineCell   = 格心速度（单个矢量无法表示膨胀，孤立高压格不动，仅作参考）
import { FluidEngineBlob as ActiveEngine } from "./engineBlob";
import type { PresetKey } from "./presets";

export type Tool = "liquid" | "wall" | "eraser" | "source";

export const TOOLS: { key: Tool; label: string; hotkey: string }[] = [
  { key: "liquid", label: "液体", hotkey: "1" },
  { key: "wall", label: "墙体", hotkey: "2" },
  { key: "eraser", label: "橡皮", hotkey: "3" },
  { key: "source", label: "水源", hotkey: "4" },
];

/** 网格分辨率的默认值与可选范围（每边格数，方形网格） */
export const DEFAULT_GRID = 64;
export const GRID_MIN = 8;
export const GRID_MAX = 256;
export const GRID_STEP = 8;

/** 按网格边长新建一台引擎（参数用默认值；切分辨率时由 UI 覆盖成当前值） */
export function createEngine(size: number): ActiveEngine {
  const e = new ActiveEngine(size, size);
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
export function floorMass(e: ActiveEngine, rows = 5): number {
  let s = 0;
  for (let y = Math.max(0, e.h - rows); y < e.h; y++) {
    const row = y * e.w;
    for (let x = 0; x < e.w; x++) s += e.mass[row + x];
  }
  return s;
}

export interface SimShared {
  engine: ActiveEngine;
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
  // 当前引擎见顶部 import（ActiveEngine）
  const engine = createEngine(DEFAULT_GRID);
  return {
    engine,
    running: true,
    speed: 1,
    tool: "liquid",
    brushSize: 4,
    needsRedraw: true,
    loadNonce: 0,
    stats: { fps: 0, mass: 0, steps: 0, floor: 0 },
  };
}

export function applyBrush(
  shared: SimShared,
  gx: number,
  gy: number,
  tool: Tool,
): void {
  const e = shared.engine;
  const r = shared.brushSize / 2;
  switch (tool) {
    case "liquid":
      e.paintLiquid(gx, gy, r);
      break;
    case "wall":
      e.paintWall(gx, gy, r);
      break;
    case "eraser":
      e.paintErase(gx, gy, r);
      break;
    case "source":
      e.paintSource(gx, gy, r);
      break;
  }
  shared.needsRedraw = true;
}

export function currentPresetDefault(): PresetKey {
  return "dam";
}
