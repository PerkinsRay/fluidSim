import { useCallback, useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import GlassPanel from '@/components/GlassPanel'
import StatChip from '@/components/StatChip'
import SimulationCanvas from './SimulationCanvas'
import ControlPanel from './ControlPanel'
import type { ParamKey } from './ControlPanel'
import PlaybackBar from './PlaybackBar'
import { TooltipProvider } from '@/components/ui/tooltip'
import { createSimShared, currentPresetDefault, DEFAULT_GRID } from '@/sim/controller'
import type { SimStats, Tool } from '@/sim/controller'
import type { PresetKey } from '@/sim/presets'
import { cn } from '@/lib/utils'

const EASE = [0.22, 1, 0.36, 1] as [number, number, number, number];

/** 模拟器工作台（S3）：画布区 + 控制面板 + 播放控制条 + 快捷键 */
export default function Workbench() {
  const sharedRef = useRef<ReturnType<typeof createSimShared> | null>(null);
  if (sharedRef.current === null) sharedRef.current = createSimShared();
  const shared = sharedRef.current;

  const [running, setRunning] = useState(shared.running);
  const [tool, setTool] = useState<Tool>(shared.tool);
  const [brushSize, setBrushSize] = useState(shared.brushSize);
  const [grid, setGrid] = useState(DEFAULT_GRID);
  const [viscosity, setViscosity] = useState(shared.sim.params.viscosity);
  const [bulkViscosity, setBulkViscosity] = useState(shared.sim.params.bulkViscosity);
  const [gravity, setGravity] = useState(shared.sim.params.gravity);
  const [expansion, setExpansion] = useState(shared.sim.params.expansion);
  const [restDensity, setRestDensity] = useState(shared.sim.params.restDensity);
  const [wallFriction, setWallFriction] = useState(shared.sim.params.wallFriction);
  const [speed, setSpeed] = useState(shared.speed);
  // 开场的水坝溃决在 createSimShared 里就发给 Worker 了
  const [preset, setPreset] = useState<PresetKey | ''>(currentPresetDefault());
  const [stats, setStats] = useState<SimStats>(shared.stats);
  const [hintVisible, setHintVisible] = useState(true);
  const [loadNonce, setLoadNonce] = useState(0);
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);

  const onStats = useCallback((s: SimStats) => setStats(s), []);
  const onFirstInteract = useCallback(() => setHintVisible(false), []);

  const togglePlay = useCallback(() => {
    shared.running = !shared.running;
    shared.sim.run(shared.running);
    setRunning(shared.running);
  }, [shared]);

  // 单步：Worker 走一步、发回新的一帧（统计随那一帧更新）
  const stepOnce = useCallback(() => {
    shared.sim.step();
  }, [shared]);

  const doReset = useCallback(() => {
    shared.sim.clear();
    setPreset('blank');
    setLoadNonce((n) => n + 1);
  }, [shared]);

  const loadPreset = useCallback(
    (p: PresetKey) => {
      shared.sim.preset(p);
      setPreset(p);
      setLoadNonce((n) => n + 1);
    },
    [shared],
  );

  // 换网格分辨率：Worker 按当前参数与预设重建一台引擎；loadNonce 变化会让画布按新尺寸重挂载
  const changeGrid = useCallback(
    (size: number) => {
      shared.sim.init(size, preset);
      setGrid(size);
      setLoadNonce((n) => n + 1);
    },
    [shared, preset],
  );

  const changeTool = useCallback(
    (t: Tool) => {
      shared.tool = t;
      setTool(t);
    },
    [shared],
  );

  const changeBrush = useCallback(
    (v: number) => {
      shared.brushSize = v;
      setBrushSize(v);
    },
    [shared],
  );

  const changeSpeed = useCallback(
    (v: number) => {
      shared.speed = v;
      shared.sim.speed(v);
      setSpeed(v);
    },
    [shared],
  );

  const changeParam = useCallback(
    (key: ParamKey, v: number) => {
      if (key === 'speed') {
        changeSpeed(v);
        return;
      }
      shared.sim.param(key, v);
      if (key === 'viscosity') setViscosity(v);
      else if (key === 'bulkViscosity') setBulkViscosity(v);
      else if (key === 'expansion') setExpansion(v);
      else if (key === 'restDensity') setRestDensity(v);
      else if (key === 'wallFriction') setWallFriction(v);
      else setGravity(v);
    },
    [shared, changeSpeed],
  );

  // ---- 快捷键 ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      switch (e.key) {
        case ' ':
          e.preventDefault();
          togglePlay();
          break;
        case 'n':
        case 'N':
          stepOnce();
          break;
        case 'r':
        case 'R':
          setResetConfirmOpen(true);
          break;
        case '1':
          changeTool('liquid');
          break;
        case '2':
          changeTool('wall');
          break;
        case '3':
          changeTool('eraser');
          break;
        case '4':
          changeTool('source');
          break;
        case '[':
          changeBrush(Math.max(1, shared.brushSize - 1));
          break;
        case ']':
          changeBrush(Math.min(12, shared.brushSize + 1));
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [shared, togglePlay, stepOnce, changeTool, changeBrush]);

  return (
    <section id="simulator" className="relative max-w-[1600px] mx-auto px-4 md:px-8 pb-16 scroll-mt-16">
      {/* 背景装饰：aurora 光斑 */}
      <div aria-hidden className="absolute inset-0 -z-10 overflow-hidden pointer-events-none">
        <div className="absolute -top-10 -left-10 w-[400px] h-[400px] rounded-full bg-cyan-400/[0.12] blur-[100px] animate-aurora-a" />
        <div className="absolute bottom-0 right-0 w-[500px] h-[500px] rounded-full bg-blue-500/10 blur-[100px] animate-aurora-b" />
      </div>

      <TooltipProvider delayDuration={300}>
        <div className="grid grid-cols-1 lg:grid-cols-[300px_1fr] gap-5">
          {/* 控制面板（移动端在下方） */}
          <motion.div
            initial={{ opacity: 0, x: -24 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true, amount: 0.15 }}
            transition={{ duration: 0.7, ease: EASE }}
            className="order-2 lg:order-1"
          >
            <ControlPanel
              tool={tool}
              onTool={changeTool}
              brushSize={brushSize}
              onBrushSize={changeBrush}
              params={{ viscosity, bulkViscosity, gravity, speed, expansion, restDensity, wallFriction }}
              onParam={changeParam}
              grid={grid}
              onGrid={changeGrid}
            />
          </motion.div>

          {/* 画布区 */}
          <motion.div
            initial={{ opacity: 0, x: 24 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true, amount: 0.15 }}
            transition={{ duration: 0.7, ease: EASE, delay: 0.15 }}
            className="order-1 lg:order-2"
          >
            <GlassPanel className="p-3 md:p-4">
              {/* (a) 状态栏 */}
              <div className="h-9 flex items-center justify-between mb-3">
                <span className="flex items-center gap-2 text-xs font-mono">
                  <span
                    className={cn(
                      'w-2 h-2 rounded-full',
                      running ? 'bg-emerald-400 animate-pulse-dot' : 'bg-slate-500',
                    )}
                  />
                  <span className="text-muted-foreground">{running ? '运行中' : '已暂停'}</span>
                </span>
                <span className="flex items-center gap-2">
                  <StatChip label="FPS" value={String(stats.fps).padStart(2, '0')} dotClass="bg-emerald-400" />
                  {/* 诊断：一步模拟 / 画一帧各多少 ms —— FPS 低时看是哪个慢 */}
                  <StatChip label="模拟ms" value={stats.stepMs.toFixed(1)} dotClass="bg-violet-400" />
                  <StatChip label="渲染ms" value={stats.renderMs.toFixed(1)} dotClass="bg-pink-400" />
                  {/* 算模拟的线程数 / 逻辑核数（浏览器只给核数）；没用上多线程时悬停看原因 */}
                  <span
                    title={
                      shared.sim.whyNoPar ||
                      stats.why ||
                      (stats.threads > 1 ? `${stats.threads} 个线程按行分段一起算模拟` : `打算用 ${shared.sim.simThreads} 个线程（帮手线程还在启动）`) +
                        `；画画面：${stats.renderThreads > 0 ? `${stats.renderThreads} 个渲染线程` : '主线程自己画'}`
                    }
                  >
                    <StatChip
                      label="线程/核"
                      value={`${stats.threads}+${stats.renderThreads}/${shared.sim.cores}`}
                      dotClass={stats.threads > 1 ? 'bg-emerald-400' : 'bg-slate-500'}
                    />
                  </span>
                  <StatChip
                    label="物质"
                    value={String(Math.round(stats.mass))}
                    dotClass="bg-cyan-400"
                  />
                  <StatChip
                    label="步数"
                    value={String(stats.steps).padStart(5, '0')}
                    dotClass="bg-slate-400"
                  />
                  {/* 临时读数：底部 5 行的总质量，排查"水瞬间到地面" */}
                  <StatChip
                    label="地面"
                    value={String(Math.round(stats.floor))}
                    dotClass="bg-amber-400"
                  />
                </span>
              </div>

              {/* (b) 画布本体（预设载入闪白：filter brightness 过渡） */}
              <motion.div
                key={loadNonce}
                initial={{ filter: 'brightness(1.6)' }}
                animate={{ filter: 'brightness(1)' }}
                transition={{ duration: 0.4, ease: 'easeOut' }}
              >
                <SimulationCanvas
                  shared={shared}
                  onStats={onStats}
                  onFirstInteract={onFirstInteract}
                  showHint={hintVisible}
                />
              </motion.div>

              {/* (c) 播放控制条 */}
              <PlaybackBar
                running={running}
                onTogglePlay={togglePlay}
                onStep={stepOnce}
                onReset={doReset}
                preset={preset}
                onPreset={loadPreset}
                speed={speed}
                onSpeed={changeSpeed}
                confirmOpen={resetConfirmOpen}
                onConfirmOpenChange={setResetConfirmOpen}
              />
            </GlassPanel>
          </motion.div>
        </div>
      </TooltipProvider>
    </section>
  );
}
