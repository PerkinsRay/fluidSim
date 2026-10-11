import { AnimatePresence, motion } from 'framer-motion'
import { cn } from '@/lib/utils'

/** 状态栏小徽章：label + 小圆点 + 等宽数值，数值变化时滚动过渡 */
export default function StatChip({
  label,
  value,
  dotClass,
}: {
  label: string
  value: string
  dotClass: string
}) {
  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-white/5 border border-subtle font-mono text-xs tabular-nums">
      <span className={cn('w-1.5 h-1.5 rounded-full', dotClass)} />
      <span className="text-muted-foreground">{label}</span>
      <span className="relative inline-block overflow-hidden min-w-[3.5ch] text-right">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={value}
            initial={{ y: 6, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: -6, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="inline-block"
          >
            {value}
          </motion.span>
        </AnimatePresence>
      </span>
    </span>
  )
}
