/**
 * 模拟控制器共享状态：在 React 状态与 rAF 渲染循环之间共享的可变对象。
 * UI 回调直接修改它；渲染循环每帧读取它，避免高频 setState。
 * 模拟本身跑在 Web Worker 里（sim.worker.ts）：这里只持有 SimClient —— 发命令、取最新一帧。
 */

import { SimClient } from "./simClient";
import { SHOW_BLOCKS } from "./render";
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

export interface SimStats {
  fps: number;
  mass: number;
  steps: number;
  /** 底部 5 行的总质量（临时读数：排查"水瞬间到地面"） */
  floor: number;
  /** 诊断：Worker 里一步多少 ms、主线程画一帧多少 ms（FPS 低时看是哪个慢） */
  stepMs: number;
  renderMs: number;
  /** 实际在用几个线程算模拟、多线程没用上的原因、几个线程在画画面（0 = 主线程自己画） */
  threads: number;
  why: string;
  renderThreads: number;
}

export interface SimShared {
  /** 模拟（在 Worker 里）：命令发过去，最新一帧在 sim.view */
  sim: SimClient;
  running: boolean;
  /** 速度倍率（0.125~2）：每帧走 round(8 × 速度) 步（0.125× = 1 步，2× = 16 步） */
  speed: number;
  tool: Tool;
  brushSize: number;
  stats: SimStats;
}

export function createSimShared(): SimShared {
  // 引擎在 Worker 里（用哪个引擎见 simHost.ts 顶部）；开场就是水坝溃决
  // 画水块形状（render.ts 的 SHOW_BLOCKS）时 Worker 要多发一份水块数据
  const sim = new SimClient(DEFAULT_GRID, currentPresetDefault(), SHOW_BLOCKS);
  return {
    sim,
    running: true,
    speed: 1,
    tool: "liquid",
    brushSize: 4,
    stats: { fps: 0, mass: 0, steps: 0, floor: 0, stepMs: 0, renderMs: 0, threads: 1, why: "", renderThreads: 0 },
  };
}

/** 一串画刷落点（x, y, x, y, …）一次发给 Worker */
export function applyBrush(shared: SimShared, pts: number[], tool: Tool): void {
  shared.sim.paint(tool, pts, shared.brushSize / 2);
}

export function currentPresetDefault(): PresetKey {
  return "dam";
}
