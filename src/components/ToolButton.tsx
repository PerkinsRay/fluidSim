import { motion } from 'framer-motion'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

/** 画刷工具按钮（图标 + 中文标签 + 快捷键角标），含激活态脉冲光环 */
export default function ToolButton({
  icon: Icon,
  label,
  hotkey,
  active,
  onClick,
}: {
  icon: LucideIcon
  label: string
  hotkey: string
  active: boolean
  onClick: () => void
}) {
  return (
    <motion.button
      type="button"
      onClick={onClick}
      whileTap={{ scale: 0.95 }}
      transition={{ type: 'spring', stiffness: 500, damping: 20 }}
      className={cn(
        'relative h-16 rounded-lg border flex flex-col items-center justify-center gap-1.5 transition-colors duration-200',
        active
          ? 'border-cyan-400 bg-cyan-400/10 text-cyan-300 animate-pulse-ring'
          : 'border-subtle text-muted-foreground hover:border-slate-400 hover:text-foreground',
      )}
    >
      <Icon size={20} />
      <span className="text-xs">{label}</span>
      <span className="kbd absolute top-1 right-1">{hotkey}</span>
    </motion.button>
  )
}
