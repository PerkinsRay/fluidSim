import { Droplets, BrickWall, Eraser, Waves } from 'lucide-react'
import GlassPanel from '@/components/GlassPanel'
import ToolButton from '@/components/ToolButton'
import ParamSlider from '@/components/ParamSlider'
import { TOOLS, GRID_MIN, GRID_MAX, GRID_STEP } from '@/sim/controller'
import type { Tool } from '@/sim/controller'

const TOOL_ICONS = { liquid: Droplets, wall: BrickWall, eraser: Eraser, source: Waves } as const;

export interface ParamValues {
  viscosity: number
  bulkViscosity: number
  gravity: number
  speed: number
  expansion: number
  restDensity: number
  wallBounce: number
  tension: number
  thinPush: number
}

export type ParamKey = keyof ParamValues

/** 控制面板（S3.2）：绘制工具 + 画刷大小 + 物理参数 */
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
  onParam: (key: ParamKey, v: number) => void
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
            label="法向粘性"
            en="Bulk Viscosity"
            min={0}
            max={0.95}
            step={0.05}
            value={params.bulkViscosity}
            onChange={(v) => onParam('bulkViscosity', v)}
            format={(v) => v.toFixed(2)}
            tooltip="压缩方向的粘性：每个面和同方向上前后相邻的面交换动量（水平速度和左右的、竖直速度和上下的），总动量不变。粘稠度只管层与层之间的滑动，管不到水池上下“弹”的压缩波——没有它水停不下来，粘稠度拉满也一样。0 = 关闭；越大水越快静下来，平移、下落不受影响"
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
            tooltip="墙只给力、不改速度：水冲向墙时，贴墙那一格多一份冲击压力 2·系数·m·v²，把水减速、推回去、推向两侧。同时决定墙有多滑：粘性里墙被当作速度 0 的水，拖拽 × (1 − 系数)——0 = 墙完全不滑，晃动被墙磨停但撞墙弹不回来；1 = 光滑墙，弹得最远、晃得更久。静止的水不受影响"
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
            min={0.125}
            max={2}
            step={0.125}
            value={params.speed}
            onChange={(v) => onParam('speed', v)}
            format={(v) => `${v.toFixed(3).replace(/\.?0+$/, '')}× · ${Math.round(8 * v)} 步`}
            tooltip="每帧走几步 = 8 × 速度：0.125× = 1 步，1× = 8 步，2× = 16 步。模拟和画面一帧一帧锁步走、每一帧都画：网格大、一步很慢时，步数多画面就卡（帧数 ≈ 1000 / (步数 × 一步 ms)），调小速度画面就顺（与播放条上的紧凑滑杆联动，同一状态）"
          />
        </div>
      </section>

    </GlassPanel>
  );
}
