import { useEffect, useRef, useState } from 'react'
import { HelpCircle } from 'lucide-react'
import { Slider } from '@/components/ui/slider'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

/**
 * 参数滑杆：标签行（中文名 + 英文小字 + mono 数值读数）+ 定制 Slider。
 * 拖动时数值读数短暂放大并变为 cyan。
 */
export default function ParamSlider({
  label,
  en,
  min,
  max,
  step,
  value,
  onChange,
  format,
  tooltip,
  compact,
}: {
  label: string
  en?: string
  min: number
  max: number
  step: number
  value: number
  onChange: (v: number) => void
  format?: (v: number) => string
  tooltip?: string
  compact?: boolean
}) {
  const [dragging, setDragging] = useState(false)
  const timer = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current)
    }
  }, [])

  const display = format ? format(value) : value.toFixed(2).replace(/\.?0+$/, '')

  return (
    <div className={cn('flex flex-col', compact ? 'gap-1.5' : 'gap-2')}>
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {label}
          {en && <span className="font-mono text-[10px] uppercase tracking-widest opacity-70">{en}</span>}
          {tooltip && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button type="button" aria-label={`${label}说明`} className="hover:text-cyan-300 transition-colors">
                  <HelpCircle size={12} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-[220px] text-xs">
                {tooltip}
              </TooltipContent>
            </Tooltip>
          )}
        </span>
        <span
          className={cn(
            'font-mono text-sm tabular-nums transition-all duration-200',
            dragging ? 'scale-[1.15] text-cyan-300' : 'text-foreground',
          )}
        >
          {display}
        </span>
      </div>
      <Slider
        min={min}
        max={max}
        step={step}
        value={[value]}
        onValueChange={([v]) => {
          onChange(v)
          setDragging(true)
          if (timer.current !== null) window.clearTimeout(timer.current)
          timer.current = window.setTimeout(() => setDragging(false), 300)
        }}
        className={cn(
          '[&_[data-slot=slider-track]]:bg-white/10',
          '[&_[data-slot=slider-range]]:bg-gradient-to-r [&_[data-slot=slider-range]]:from-blue-500 [&_[data-slot=slider-range]]:to-cyan-400',
          '[&_[data-slot=slider-thumb]]:bg-white [&_[data-slot=slider-thumb]]:border-cyan-400 [&_[data-slot=slider-thumb]]:hover:ring-cyan-400/20',
        )}
      />
    </div>
  )
}
