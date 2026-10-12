import { Droplets, BrickWall, Eraser, Waves } from 'lucide-react'
import GlassPanel from '@/components/GlassPanel'
import ToolButton from '@/components/ToolButton'
import ParamSlider from '@/components/ParamSlider'
import { Separator } from '@/components/ui/separator'
import { TOOLS, GRID_MIN, GRID_MAX, GRID_STEP } from '@/sim/controller'
import type { Tool } from '@/sim/controller'

const TOOL_ICONS = { liquid: Droplets, wall: BrickWall, eraser: Eraser, source: Waves } as const;

export interface ParamValues {
  elasticity: number
  viscosity: number
  gravity: number
  speed: number
  expansion: number
  selfBase: number
  restDensity: number
  wallBounce: number
  tension: number
  thinPush: number
}

/** 控制面板（S3.2）：绘制工具 + 画刷大小 + 物理参数 + 规则说明 */
export default function ControlPanel({
  tool,
  onTool,
  brushSize,
  onBrushSize,
  params,
  onParam,
  grid,
  onGrid,
}: {
  tool: Tool
  onTool: (t: Tool) => void
  brushSize: number
  onBrushSize: (v: number) => void
  params: ParamValues
  onParam: (key: 'elasticity' | 'viscosity' | 'gravity' | 'speed' | 'expansion' | 'selfBase' | 'restDensity' | 'wallBounce' | 'tension' | 'thinPush', v: number) => void
  grid: number
  onGrid: (v: number) => void
}) {
  return (
    <GlassPanel className="p-5 flex flex-col gap-6">
      {/* (a) 绘制工具 */}
      <section>
        <h3 className="text-xs tracking-widest text-muted-foreground mb-3">绘制工具</h3>
        <div className="grid grid-cols-2 gap-2">
          {TOOLS.map((t) => (
            <ToolButton
              key={t.key}
              icon={TOOL_ICONS[t.key]}
              label={t.label}
              hotkey={t.hotkey}
              active={tool === t.key}
              onClick={() => onTool(t.key)}
            />
          ))}
        </div>
        <div className="mt-4 flex flex-col gap-4">
          <ParamSlider
            compact
            label="笔刷"
            en="Brush"
            min={1}
            max={12}
            step={1}
            value={brushSize}
            onChange={onBrushSize}
            format={(v) => `${v} 格`}
          />
          <ParamSlider
            compact
            label="网格"
            en="Grid"
            min={GRID_MIN}
            max={GRID_MAX}
            step={GRID_STEP}
            value={grid}
            onChange={onGrid}
            format={(v) => `${v}×${v}`}
            tooltip="模拟网格的分辨率（每边格数，方形）。改这个会按当前预设重建整场水——格子越细，水柱越深、下落过程越长、细节越多；代价是每步更贵。画布显示尺寸不变。"
          />
        </div>
      </section>

      {/* (b) 物理参数 */}
      <section>
        <h3 className="text-xs tracking-widest text-muted-foreground mb-3">物理参数</h3>
        <div className="flex flex-col gap-4">
          <ParamSlider
            label="固有膨胀系数"
            en="Expansion"
            min={0}
            max={2}
            step={0.1}
            value={params.expansion}
            onChange={(v) => onParam('expansion', v)}
            format={(v) => v.toFixed(1)}
            tooltip="压力系数 c 的 1/100：每格压力 p = c·max(0, m − m₀)（c = 0~200）。c 越大水越不可压缩——水深 D 格时 c ≳ 10·g·D 才压缩不到 10%；太小时水会被重力压进池底。c=0 则完全没有压力"
          />
          <ParamSlider
            label="弹性系数"
            en="Elasticity"
            min={1}
            max={999}
            step={1}
            value={params.elasticity}
            onChange={(v) => onParam('elasticity', v)}
            format={(v) => v.toFixed(0)}
            tooltip='受压反作用的"硬度"：反馈比例 ρ=k/(k+1)，越大越接近 1（完全反作用 = 不可压缩，加水能抬高水位）；越小水越软、越容易被压缩'
          />
          <ParamSlider
            label="粘稠度"
            en="Viscosity"
            min={0}
            max={0.95}
            step={0.05}
            value={params.viscosity}
            onChange={(v) => onParam('viscosity', v)}
            format={(v) => v.toFixed(2)}
            tooltip="剪切粘性：相邻的水之间按流速差交换动量（快的拖慢的、慢的拖快的，总动量不变）。只抹平速度差，不阻尼整体平动——拉满也不会让空中的水落得更慢，只会让晃动更快停下、水流像蜂蜜一样黏。越低越像水；0 时几乎没有耗散，水会晃很久"
          />
          <ParamSlider
            label="重力"
            en="Gravity"
            min={0}
            max={3}
            step={0.1}
            value={params.gravity}
            onChange={(v) => onParam('gravity', v)}
            format={(v) => v.toFixed(1)}
            tooltip="每格对下方施加的恒定压力。为零时液体悬浮弥散"
          />
          <ParamSlider
            label="自重压力"
            en="Self Weight"
            min={0.5}
            max={2}
            step={0.1}
            value={params.selfBase}
            onChange={(v) => onParam('selfBase', v)}
            format={(v) => v.toFixed(1)}
            tooltip="每格自身质量也算一份压力（α·m·g），叠加在'上方来压'上再取对冲传递——这就是水能撑住自己、不摊成一层的那部分压力。0.5 ≈ 原行为；越大液柱越硬、液面上方雾状水汽越厚（低于 0.5 水体变薄，0 会退化成一层密的薄片，故下限取 0.5）"
          />
          <ParamSlider
            label="静止密度"
            en="Rest Density"
            min={0}
            max={3}
            step={0.1}
            value={params.restDensity}
            onChange={(v) => onParam('restDensity', v)}
            format={(v) => v.toFixed(1)}
            tooltip="低于这个密度的液体不施反作用力（只保留自重与固有膨胀）——稀薄的水失去支撑，会自由落回水体而不是挂在液面上方成雾。0 = 关闭（按现在的行为）"
          />
          <ParamSlider
            label="撞墙反弹"
            en="Wall Bounce"
            min={0}
            max={1}
            step={0.05}
            value={params.wallBounce}
            onChange={(v) => onParam('wallBounce', v)}
            format={(v) => v.toFixed(2)}
            tooltip="墙只给力、不改速度：水冲向墙时，贴墙那一格多一份冲击压力 2·系数·m·v²，把水减速、推回去、推向两侧。0 = 只有普通压力；1 = 完全反射的冲击力。静止的水不受影响"
          />
          <ParamSlider
            label="稀相推力"
            en="Thin Push"
            min={0}
            max={1}
            step={0.05}
            value={params.thinPush}
            onChange={(v) => onParam('thinPush', v)}
            format={(v) => v.toFixed(2)}
            tooltip="双井势 u < 0.5 的那一半（u = m / 静止密度，强度 = 系数 × 20）：不到半满的水压力为正、往外推。大了下落的水会被拉稀、散成雾。0 = 关闭。静止密度为 0 时不起作用"
          />
          <ParamSlider
            label="内聚拉力"
            en="Tension"
            min={0}
            max={1}
            step={0.05}
            value={params.tension}
            onChange={(v) => onParam('tension', v)}
            format={(v) => v.toFixed(2)}
            tooltip="双井势 u > 0.5 的那一半（u = m / 静止密度，强度 = 系数 × 20）：超过半满、没到满格的水压力为负、往回拉。大了水会挂在天花板上，薄层会分成一格满一格空。0 = 关闭。静止密度为 0 时不起作用"
          />
          <ParamSlider
            label="模拟速度"
            en="Speed"
            min={0.25}
            max={1}
            step={0.25}
            value={params.speed}
            onChange={(v) => onParam('speed', v)}
            format={(v) => `${v.toFixed(2).replace(/\.?0+$/, '')}×`}
            tooltip="每帧模拟步数的倍率（基准 8 步/帧）：一步最多推进一格，所以这个值直接就是每帧走几格。1× = 每帧 8 步；调小 = 放慢观察。模拟变贵时会自动让步以保住 60fps（与播放条上的紧凑滑杆联动，同一状态）"
          />
        </div>
      </section>

      {/* (c) 规则速览 */}
      <section>
        <Separator className="bg-subtle mb-4" />
        <a href="#rules" className="block text-xs text-muted-foreground leading-relaxed hover:text-cyan-300 transition-colors">
          规则 1：对冲压力交叉传递四邻 · 规则 2：合力驱动流动且不反超 · 规则 3：重力恒压向下
        </a>
      </section>
    </GlassPanel>
  );
}
