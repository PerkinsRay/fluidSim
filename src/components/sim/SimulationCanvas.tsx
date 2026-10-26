import { useEffect, useRef } from 'react'
import { renderEngine, drawSources } from '@/sim/render'
import { RenderPool, renderPoolAvailable } from '@/sim/renderPool'
import { applyBrush } from '@/sim/controller'
import type { SimShared, SimStats, Tool } from '@/sim/controller'
import type { CellProbe } from '@/sim/engineBlob'
import { cn } from '@/lib/utils'

/** 各工具的画刷指示环颜色 */
const TOOL_RING: Record<Tool, string> = {
  liquid: '#22D3EE',
  wall: '#94A3B8',
  eraser: '#FB7185',
  source: '#34D399',
}

/** 悬停读数（调试）：一格的质量 / 压力 / 四条边的压力差与流速 */
function formatProbe(pr: CellProbe | null): string {
  if (!pr) return '';
  const edge = (n: string, e: { dp: number; v: number }) =>
    `${n} Δp ${e.dp >= 0 ? '+' : ''}${e.dp.toFixed(2)}   v ${e.v >= 0 ? '+' : ''}${e.v.toFixed(3)}`;
  return [
    `格 (${pr.x}, ${pr.y})`,
    `质量 ${pr.mass.toFixed(2)}   压力 ${pr.pressure.toFixed(2)}`,
    edge('右', pr.right),
    edge('左', pr.left),
    edge('下', pr.down),
    edge('上', pr.up),
  ].join('\n');
}

/**
 * 画布本体 + 画刷指示环 + 渲染循环。
 * 模拟在 Web Worker 里一帧一帧地算（每帧 8 步 × 速度，见 simHost.ts），和这里用两份缓冲交接：
 * 这里画第 N 帧时 Worker 算第 N+1 帧；谁快谁等 —— 模拟算完了下一帧但这边还没画完，模拟等；
 * 这边要画了但下一帧还没算完，这边等（这次刷新不画）。
 * 渲染循环只依赖共享对象（ref），不随 React 状态重建。
 */
export default function SimulationCanvas({
  shared,
  onStats,
  onFirstInteract,
  showHint,
}: {
  shared: SimShared
  onStats: (s: SimStats) => void
  onFirstInteract: () => void
  showHint: boolean
}) {
  const view = shared.sim.view;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ringRef = useRef<HTMLCanvasElement>(null);
  const paintingRef = useRef(false);
  const lastCellRef = useRef<{ x: number; y: number } | null>(null);
  const pointerRef = useRef<{ x: number; y: number; inside: boolean } | null>(null);
  const interactedRef = useRef(false);
  const ringDrawRef = useRef<() => void>(() => {});
  const readoutRef = useRef<HTMLPreElement>(null);
  const onStatsRef = useRef(onStats);
  onStatsRef.current = onStats;
  const onFirstRef = useRef(onFirstInteract);
  onFirstRef.current = onFirstInteract;

  // ---- 渲染循环 ----
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const sim = shared.sim;
    const image = ctx.createImageData(view.pixelWidth, view.pixelHeight);
    // 多线程画画面（见 renderPool.ts）：页面跨源隔离时开几个渲染 Worker 一起画；不行就主线程自己画
    const rCount = renderPoolAvailable() ? sim.renderThreads : 0;
    const pool = rCount > 0 ? new RenderPool(view.w, view.h, view.cell, rCount) : null;
    /** 交给渲染 Worker 正在画的那一帧（画完才拷进画布、才还缓冲） */
    let inRender = false;
    let rStart = 0;
    /** 拷进画布 + 水源圆点 */
    const present = (now: number) => {
      image.data.set(pool!.pixels);
      ctx.putImageData(image, 0, 0);
      drawSources(view, ctx, now);
    };

    let raf = 0;
    let frames = 0;
    let windowStart = performance.now();
    let probeKey = '';
    /** 画一帧（renderEngine，含 putImageData）的耗时，滑动平均 */
    let renderMs = 0;

    const loop = (now: number) => {
      // 下一帧算好了就画（按顺序、不跳帧）；还没算好就这次不画、等。画完还回去，Worker 才能用这份缓冲算再下一帧。
      // 渲染 Worker 在画的时候：等它画完（这次刷新看一眼，没画完就下次再看），拷进画布，再还缓冲、取下一帧
      let drew = false;
      if (inRender && pool!.done()) {
        if (pool!.usable) present(now);
        else renderEngine(view, ctx, image, now); // 渲染线程坏了：这一帧主线程自己画
        renderMs += 0.1 * (performance.now() - rStart - renderMs);
        inRender = false;
        drew = true;
        sim.ack();
      }
      if (!inRender && sim.takeFrame()) {
        const t0 = performance.now();
        if (pool && pool.usable) {
          pool.start(view);
          rStart = t0;
          inRender = true;
        } else {
          renderEngine(view, ctx, image, now);
          renderMs += 0.1 * (performance.now() - t0 - renderMs);
          drew = true;
          sim.ack();
        }
      }
      // FPS 数的是画面真正更新的次数；暂停时画面不变，按刷新次数算（不然一暂停就是 0）
      if (drew || !shared.running) frames++;

      // 悬停读数（调试）：鼠标指到哪一格，就让 Worker 在每一帧里带上那一格的读数
      const readout = readoutRef.current;
      if (readout) {
        const pt = pointerRef.current;
        let gx = -1,
          gy = -1;
        if (pt && pt.inside) {
          const rect = canvas.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            gx = Math.floor(((pt.x - rect.left) / rect.width) * view.w);
            gy = Math.floor(((pt.y - rect.top) / rect.height) * view.h);
          }
        }
        const key = `${gx},${gy}`;
        if (key !== probeKey) {
          probeKey = key;
          sim.probeAt(gx, gy);
        }
        const text = gx >= 0 ? formatProbe(view.probe) : '';
        if (readout.textContent !== text) readout.textContent = text;
      }

      // FPS 滑动窗口（500ms）：数的是真正画出来的帧
      if (now - windowStart >= 500) {
        const fps = Math.round((frames * 1000) / (now - windowStart));
        frames = 0;
        windowStart = now;
        onStatsRef.current({ fps, mass: view.totalMass, steps: view.steps, floor: view.floor, stepMs: view.stepMs, renderMs, threads: view.threads, why: view.why,
          renderThreads: pool && pool.usable ? pool.count : 0 });
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      pool?.dispose();
    };
  }, [view, shared]);

  // ---- 指示环画布尺寸跟随显示尺寸 ----
  useEffect(() => {
    const ring = ringRef.current;
    const main = canvasRef.current;
    if (!ring || !main) return;
    const resize = () => {
      const rect = main.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      ring.width = Math.max(1, Math.round(rect.width * dpr));
      ring.height = Math.max(1, Math.round(rect.height * dpr));
      drawRing();
    };
    const drawRing = () => {
      const rctx = ring.getContext('2d');
      if (!rctx) return;
      rctx.clearRect(0, 0, ring.width, ring.height);
      const p = pointerRef.current;
      if (!p || !p.inside) return;
      const rect = main.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const cellCss = rect.width / view.w;
      const cx = (p.x - rect.left) * dpr;
      const cy = (p.y - rect.top) * dpr;
      const r = (shared.brushSize / 2) * cellCss * dpr;
      const color = TOOL_RING[shared.tool];
      rctx.beginPath();
      rctx.arc(cx, cy, Math.max(r, 3), 0, Math.PI * 2);
      rctx.fillStyle = color + '1A'; // 10% 同色填充
      rctx.fill();
      rctx.lineWidth = 1.5 * dpr;
      rctx.strokeStyle = color;
      rctx.stroke();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(main);
    resize();
    ringDrawRef.current = drawRing;
    return () => ro.disconnect();
  }, [view, shared]);

  // ---- 绘制交互 ----
  const toGrid = (clientX: number, clientY: number) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return {
      gx: ((clientX - rect.left) / rect.width) * view.w - 0.5,
      gy: ((clientY - rect.top) / rect.height) * view.h - 0.5,
    };
  };

  // 一段拖动每移动半格盖一次章；整段的落点一条消息发给 Worker
  const paintLine = (from: { x: number; y: number } | null, to: { x: number; y: number }, tool: Tool) => {
    if (!from) {
      applyBrush(shared, [to.x, to.y], tool);
      return;
    }
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dist = Math.max(Math.abs(dx), Math.abs(dy));
    const n = Math.max(1, Math.ceil(dist * 2));
    const pts: number[] = [];
    for (let s = 1; s <= n; s++) pts.push(from.x + (dx * s) / n, from.y + (dy * s) / n);
    applyBrush(shared, pts, tool);
  };

  const markInteracted = () => {
    if (!interactedRef.current) {
      interactedRef.current = true;
      onFirstRef.current();
    }
  };

  return (
    <div className="relative">
      <canvas
        ref={canvasRef}
        width={view.pixelWidth}
        height={view.pixelHeight}
        style={{ width: '100%', aspectRatio: `${view.w} / ${view.h}`, imageRendering: 'pixelated', touchAction: 'none' }}
        className="block rounded-lg bg-canvasbg border border-subtle cursor-crosshair shadow-[inset_0_0_60px_rgba(34,211,238,0.04)]"
        onContextMenu={(e) => e.preventDefault()}
        onPointerDown={(e) => {
          e.preventDefault();
          markInteracted();
          paintingRef.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          const { gx, gy } = toGrid(e.clientX, e.clientY);
          const tool: Tool = e.button === 2 ? 'eraser' : shared.tool;
          shared.sim.beginStroke(); // 新的一笔：每格重新可以加一次水
          paintLine(null, { x: gx, y: gy }, tool);
          lastCellRef.current = { x: gx, y: gy };
        }}
        onPointerMove={(e) => {
          pointerRef.current = { x: e.clientX, y: e.clientY, inside: true };
          ringDrawRef.current();
          if (!paintingRef.current || e.buttons === 0) {
            lastCellRef.current = null;
            return;
          }
          markInteracted();
          const { gx, gy } = toGrid(e.clientX, e.clientY);
          const tool: Tool = (e.buttons & 2) !== 0 ? 'eraser' : shared.tool;
          paintLine(lastCellRef.current, { x: gx, y: gy }, tool);
          lastCellRef.current = { x: gx, y: gy };
        }}
        onPointerUp={() => {
          paintingRef.current = false;
          lastCellRef.current = null;
        }}
        onPointerLeave={() => {
          paintingRef.current = false;
          lastCellRef.current = null;
          if (pointerRef.current) pointerRef.current.inside = false;
          ringDrawRef.current();
        }}
      />
      <canvas
        ref={ringRef}
        className="absolute inset-0 w-full h-full pointer-events-none rounded-lg"
      />
      <pre
        ref={readoutRef}
        className="absolute top-2 left-2 px-2.5 py-1.5 rounded-md bg-black/60 backdrop-blur-sm text-[10px] leading-snug text-cyan-100 font-mono whitespace-pre pointer-events-none"
      />
      <div
        className={cn(
          'absolute bottom-2 left-2 px-2.5 py-1 rounded-full bg-black/50 backdrop-blur-sm text-[10px] text-muted-foreground pointer-events-none transition-opacity duration-500',
          showHint ? 'opacity-100' : 'opacity-0',
        )}
      >
        按住拖动以绘制 · 右键=橡皮
      </div>
    </div>
  );
}
