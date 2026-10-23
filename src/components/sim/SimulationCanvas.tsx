import { useEffect, useRef } from 'react'
import { renderEngine } from '@/sim/render'
import { applyBrush, floorMass } from '@/sim/controller'
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

/**
 * 每帧的模拟步数上限——**它才是"画面动得多快"的旋钮**：一步最多推进一格，所以每帧几步就是
 * 每帧走几格。8 格画布配 dt=0.01 时，一次自由落体（t=√(2h/g)≈4）约 50 帧 ≈ 0.8 秒落地。
 * 速度滑杆缩放它（0.25× → 2 步），时间预算只作兜底（模拟变贵时自动让步，保 60fps）。
 */
const FRAME_MS = 1000 / 60;
const MAX_STEPS_PER_FRAME = 8;

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
  const engine = shared.engine;
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
    const image = ctx.createImageData(engine.pixelWidth, engine.pixelHeight);

    let raf = 0;
    let frames = 0;
    let windowStart = performance.now();
    let renderMs = 0; // 上一帧渲染耗时：从模拟预算里扣掉，保证渲染还是 60fps

    const loop = (now: number) => {
      // 模拟推进：每帧固定几步（速度滑杆缩放），时间预算只兜底保 60fps
      if (shared.running) {
        const maxSteps = Math.max(
          1,
          Math.round(MAX_STEPS_PER_FRAME * Math.min(shared.speed, 1)),
        );
        const deadline = now + FRAME_MS - renderMs;
        let steps = 0;
        do {
          engine.step();
          steps++;
        } while (steps < maxSteps && performance.now() < deadline);
      }

      if (shared.running || shared.needsRedraw) {
        const t0 = performance.now();
        renderEngine(engine, ctx, image, now);
        renderMs = performance.now() - t0;
        shared.needsRedraw = false;
      }

      // 悬停读数（调试）：鼠标指到哪一格就读哪一格
      const readout = readoutRef.current;
      if (readout) {
        const pt = pointerRef.current;
        let text = '';
        if (pt && pt.inside) {
          const rect = canvas.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            const gx = Math.floor(((pt.x - rect.left) / rect.width) * engine.w);
            const gy = Math.floor(((pt.y - rect.top) / rect.height) * engine.h);
            text = formatProbe(engine.probe(gx, gy));
          }
        }
        if (readout.textContent !== text) readout.textContent = text;
      }

      // FPS 滑动窗口（500ms）
      frames++;
      if (now - windowStart >= 500) {
        const fps = Math.round((frames * 1000) / (now - windowStart));
        frames = 0;
        windowStart = now;
        onStatsRef.current({
          fps,
          mass: engine.totalMass(),
          steps: engine.stepCount,
          floor: floorMass(engine),
        });
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [engine, shared]);

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
      const cellCss = rect.width / engine.w;
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
  }, [engine, shared]);

  // ---- 绘制交互 ----
  const toGrid = (clientX: number, clientY: number) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return {
      gx: ((clientX - rect.left) / rect.width) * engine.w - 0.5,
      gy: ((clientY - rect.top) / rect.height) * engine.h - 0.5,
    };
  };

  const paintLine = (from: { x: number; y: number } | null, to: { x: number; y: number }, tool: Tool) => {
    if (!from) {
      applyBrush(shared, to.x, to.y, tool);
      return;
    }
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dist = Math.max(Math.abs(dx), Math.abs(dy));
    const n = Math.max(1, Math.ceil(dist * 2));
    for (let s = 1; s <= n; s++) {
      applyBrush(shared, from.x + (dx * s) / n, from.y + (dy * s) / n, tool);
    }
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
        width={engine.pixelWidth}
        height={engine.pixelHeight}
        style={{ width: '100%', aspectRatio: `${engine.w} / ${engine.h}`, imageRendering: 'pixelated', touchAction: 'none' }}
        className="block rounded-lg bg-canvasbg border border-subtle cursor-crosshair shadow-[inset_0_0_60px_rgba(34,211,238,0.04)]"
        onContextMenu={(e) => e.preventDefault()}
        onPointerDown={(e) => {
          e.preventDefault();
          markInteracted();
          paintingRef.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          const { gx, gy } = toGrid(e.clientX, e.clientY);
          const tool: Tool = e.button === 2 ? 'eraser' : shared.tool;
          shared.engine.beginStroke(); // 新的一笔：每格重新可以加一次水
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
