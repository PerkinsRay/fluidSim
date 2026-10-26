/**
 * 渲染 Worker：主线程开出来的（见 renderPool.ts），从共享输入画自己分到的那几块行进共享像素。
 * 画完回一条消息
 */
import { renderRows } from "./render";
import { RENDER_CHUNK, inputViews } from "./renderPool";
import type { RenderIn, RenderOut } from "./renderPool";

const scope = self as unknown as {
  postMessage(m: unknown): void;
  onmessage: ((ev: MessageEvent<RenderIn>) => void) | null;
};

let src: { w: number; h: number; cell: number; mass: Float32Array; kind: Uint8Array; rho: Float32Array } | null = null;
let px: Uint32Array | null = null;
let idx = 0,
  count = 1;

scope.onmessage = (ev) => {
  const m = ev.data;
  if (m.t === "init") {
    const v = inputViews(m.input, m.w * m.h);
    src = { w: m.w, h: m.h, cell: m.cell, mass: v.mass, kind: v.kind, rho: v.rho };
    px = new Uint32Array(m.pixels);
    idx = m.idx;
    count = m.count;
    scope.postMessage({ t: "ready" });
    return;
  }
  if (!src || !px) return;
  const H = src.h;
  for (let y0 = idx * RENDER_CHUNK; y0 < H; y0 += count * RENDER_CHUNK)
    renderRows(src, px, src.rho, null, y0, Math.min(H, y0 + RENDER_CHUNK));
  const out: RenderOut = { t: "done", no: m.no, idx };
  scope.postMessage(out);
};
