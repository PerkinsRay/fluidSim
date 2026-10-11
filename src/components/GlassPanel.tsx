import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/** 玻璃拟态容器：控制面板、规则卡片等复用 */
export default function GlassPanel({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'rounded-2xl border border-subtle bg-[#0D1420]/80 backdrop-blur-md shadow-panel',
        className,
      )}
    >
      {children}
    </div>
  )
}
