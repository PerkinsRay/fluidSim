import { AnimatePresence, motion } from 'framer-motion'
import { Play, Pause, StepForward, RotateCcw } from 'lucide-react'
import { Separator } from '@/components/ui/separator'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import ParamSlider from '@/components/ParamSlider'
import { PRESETS } from '@/sim/presets'
import type { PresetKey } from '@/sim/presets'

/** 播放控制条：播放/暂停、单步、重置（带确认气泡）、场景预设、速度滑杆 */
export default function PlaybackBar({
  running,
  onTogglePlay,
  onStep,
  onReset,
  preset,
  onPreset,
  speed,
  onSpeed,
  confirmOpen,
  onConfirmOpenChange,
}: {
  running: boolean
  onTogglePlay: () => void
  onStep: () => void
  onReset: () => void
  preset: PresetKey | ''
  onPreset: (p: PresetKey) => void
  speed: number
  onSpeed: (v: number) => void
  confirmOpen: boolean
  onConfirmOpenChange: (open: boolean) => void
}) {

  return (
    <div className="mt-3 flex items-center gap-2 flex-wrap">
      {/* 播放 / 暂停（主按钮） */}
      <Tooltip>
        <TooltipTrigger asChild>
          <motion.button
            type="button"
            onClick={onTogglePlay}
            whileHover={{ scale: 1.03 }}
            whileTap={{ scale: 0.95 }}
            aria-label={running ? '暂停' : '播放'}
            className="w-10 h-10 rounded-lg bg-cyan-400 text-[#070B14] flex items-center justify-center hover:shadow-[0_0_20px_rgba(34,211,238,0.5)] transition-shadow"
          >
            <AnimatePresence mode="wait" initial={false}>
              <motion.span
                key={running ? 'pause' : 'play'}
                initial={{ opacity: 0, rotate: -90 }}
                animate={{ opacity: 1, rotate: 0 }}
                exit={{ opacity: 0, rotate: 90 }}
                transition={{ duration: 0.25 }}
                className="flex"
              >
                {running ? <Pause size={18} /> : <Play size={18} className="ml-0.5" />}
              </motion.span>
            </AnimatePresence>
          </motion.button>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          {running ? '暂停' : '播放'} <span className="kbd ml-1">Space</span>
        </TooltipContent>
      </Tooltip>

      {/* 单步 */}
      <Tooltip>
        <TooltipTrigger asChild>
          <motion.button
            type="button"
            onClick={onStep}
            whileTap={{ scale: 0.95 }}
            aria-label="单步推进"
            className="w-10 h-10 rounded-lg border border-subtle text-muted-foreground hover:border-slate-400 hover:text-foreground flex items-center justify-center transition-colors"
          >
            <StepForward size={18} />
          </motion.button>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          单步推进 <span className="kbd ml-1">N</span>
        </TooltipContent>
      </Tooltip>

      {/* 重置（确认气泡） */}
      <Popover open={confirmOpen} onOpenChange={onConfirmOpenChange}>
        <Tooltip>
          <PopoverTrigger asChild>
            <TooltipTrigger asChild>
              <motion.button
                type="button"
                aria-label="重置"
                whileTap={{ scale: 0.95 }}
                className="w-10 h-10 rounded-lg border border-subtle text-rose-300/80 hover:border-rose-400 hover:text-rose-300 flex items-center justify-center transition-colors"
              >
                <RotateCcw size={18} />
              </motion.button>
            </TooltipTrigger>
          </PopoverTrigger>
          <TooltipContent side="top" className="text-xs">
            重置 <span className="kbd ml-1">R</span>
          </TooltipContent>
        </Tooltip>
        <PopoverContent side="top" className="w-auto p-3 bg-[#0D1420] border-subtle">
          <p className="text-xs mb-2.5">清空整个画布？</p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                onReset();
                onConfirmOpenChange(false);
              }}
              className="px-3 py-1 rounded-md bg-rose-400/90 text-[#070B14] text-xs font-medium hover:bg-rose-400 transition-colors"
            >
              确认清空
            </button>
            <button
              type="button"
              onClick={() => onConfirmOpenChange(false)}
              className="px-3 py-1 rounded-md border border-subtle text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              取消
            </button>
          </div>
        </PopoverContent>
      </Popover>

      <Separator orientation="vertical" className="h-6 bg-subtle" />

      {/* 场景预设 */}
      <Select value={preset} onValueChange={(v) => onPreset(v as PresetKey)}>
        <SelectTrigger className="w-[150px] h-10 bg-white/5 border-subtle text-xs">
          <SelectValue placeholder="场景预设" />
        </SelectTrigger>
        <SelectContent className="bg-[#0D1420] border-subtle">
          {PRESETS.map((p) => (
            <SelectItem key={p.key} value={p.key} className="text-xs">
              {p.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* 速度（与控制面板联动） */}
      <div className="ml-auto w-36 md:w-44">
        <ParamSlider
          compact
          label="速度"
          min={0.01}
          max={2}
          step={0.01}
          value={speed}
          onChange={onSpeed}
          format={(v) => `${v.toFixed(2).replace(/\.?0+$/, '')}×`}
        />
      </div>
    </div>
  );
}
