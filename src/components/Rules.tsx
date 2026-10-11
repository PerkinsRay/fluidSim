import { motion } from 'framer-motion'
import type { ReactElement } from 'react'
import { Expand, ArrowRightLeft, ArrowDownToLine } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import GlassPanel from '@/components/GlassPanel'
import { cn } from '@/lib/utils'

const EASE = [0.22, 1, 0.36, 1] as [number, number, number, number];

/* ---------------- 图示（纯 SVG） ---------------- */

/** 规则一：3×3 方格，中心 ρ，四向压力箭头 */
function DiagramPressure() {
  const cell = 24;
  const arrows = [
    { x1: 36, y1: 28, x2: 36, y2: 12, cls: 'animate-arrow-nudge-y' },
    { x1: 36, y1: 44, x2: 36, y2: 60, cls: 'animate-arrow-nudge-y' },
    { x1: 28, y1: 36, x2: 12, y2: 36, cls: 'animate-arrow-nudge-x' },
    { x1: 44, y1: 36, x2: 60, y2: 36, cls: 'animate-arrow-nudge-x' },
  ];
  return (
    <svg width="120" height="72" viewBox="0 0 72 72" className="mx-auto">
      {Array.from({ length: 9 }, (_, i) => (
        <rect
          key={i}
          x={(i % 3) * cell}
          y={Math.floor(i / 3) * cell}
          width={cell - 1}
          height={cell - 1}
          rx={2}
          fill={i === 4 ? 'rgba(34,211,238,0.35)' : 'none'}
          stroke={i === 4 ? '#22D3EE' : 'rgba(148,163,184,0.4)'}
          strokeWidth={1}
        />
      ))}
      <text x={36} y={40} textAnchor="middle" fontSize="9" fill="#67E8F9" fontFamily="'JetBrains Mono', monospace">ρ</text>
      {arrows.map((a, i) => (
        <g key={i} className={a.cls}>
          <line x1={a.x1} y1={a.y1} x2={a.x2} y2={a.y2} stroke="#22D3EE" strokeWidth={1.5} markerEnd="url(#arrCyan)" />
        </g>
      ))}
      <defs>
        <marker id="arrCyan" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
          <path d="M0,0 L6,3 L0,6 Z" fill="#22D3EE" />
        </marker>
      </defs>
    </svg>
  );
}

/** 规则二：两格压差驱动流动，管道粗细映射 Δp + 钳制标记 */
function DiagramFlow() {
  return (
    <svg width="140" height="72" viewBox="0 0 140 72" className="mx-auto">
      <rect x="8" y="16" width="40" height="40" rx="3" fill="#1E3A8A" stroke="#2563EB" strokeWidth="1" />
      <rect x="92" y="16" width="40" height="40" rx="3" fill="rgba(37,99,235,0.25)" stroke="rgba(148,163,184,0.4)" strokeWidth="1" />
      <text x="28" y="40" textAnchor="middle" fontSize="9" fill="#93C5FD" fontFamily="'JetBrains Mono', monospace">高ρ</text>
      <text x="112" y="40" textAnchor="middle" fontSize="9" fill="#7C8DA6" fontFamily="'JetBrains Mono', monospace">低ρ</text>
      <g className="animate-arrow-nudge-x">
        <rect x="48" y="28" width="44" height="16" rx="8" fill="rgba(59,130,246,0.25)" stroke="#3B82F6" strokeWidth="1" />
        <line x1="54" y1="36" x2="82" y2="36" stroke="#3B82F6" strokeWidth="3" markerEnd="url(#arrBlue)" />
      </g>
      <text x="70" y="22" textAnchor="middle" fontSize="8" fill="#60A5FA" fontFamily="'JetBrains Mono', monospace">Δp</text>
      <text x="70" y="66" textAnchor="middle" fontSize="8" fill="#7C8DA6" fontFamily="'JetBrains Mono', monospace">flow ≤ 平衡量</text>
      <defs>
        <marker id="arrBlue" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
          <path d="M0,0 L6,3 L0,6 Z" fill="#3B82F6" />
        </marker>
      </defs>
    </svg>
  );
}

/** 规则三：一列三格向下箭头 g，底部墙体上堆积 */
function DiagramGravity() {
  return (
    <svg width="72" height="96" viewBox="0 0 72 96" className="mx-auto">
      {[0, 1, 2].map((r) => (
        <g key={r}>
          <rect x="24" y={4 + r * 24} width="23" height="23" rx="2"
            fill={r === 2 ? 'rgba(52,211,153,0.25)' : 'none'}
            stroke={r === 2 ? '#34D399' : 'rgba(148,163,184,0.4)'} strokeWidth="1" />
          <g className="animate-arrow-nudge-y">
            <line x1="35.5" y1={8 + r * 24} x2="35.5" y2={20 + r * 24} stroke="#34D399" strokeWidth="1.5" markerEnd="url(#arrGreen)" />
          </g>
          <text x="56" y={20 + r * 24} fontSize="8" fill="#34D399" fontFamily="'JetBrains Mono', monospace">g</text>
        </g>
      ))}
      {/* 墙体砌块 */}
      {[0, 1, 2].map((c) => (
        <rect key={c} x={12 + c * 18} y={78} width="17" height="12" rx="1" fill="#64748B" stroke="#415166" strokeWidth="1" />
      ))}
      <defs>
        <marker id="arrGreen" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
          <path d="M0,0 L6,3 L0,6 Z" fill="#34D399" />
        </marker>
      </defs>
    </svg>
  );
}

/* ---------------- 卡片 ---------------- */

interface RuleCard {
  icon: LucideIcon;
  title: string;
  text: string;
  formula: string;
  diagram: () => ReactElement;
  lineClass: string;
  iconClass: string;
}

const CARDS: RuleCard[] = [
  {
    icon: Expand,
    title: '规则一 · 压力反作用',
    text: '每格把上下两面的压力取对冲分量（较小值）传给左右、左右两面的对冲分量传给上下——只有两侧对等的压力才会向侧向传递，单侧压来的净分量不向侧向泄漏；再加上液面基准压力。',
    formula: 'p↑↓ = ρ × min(p左, p右)，p←→ = ρ × min(p上, p下)',
    diagram: DiagramPressure,
    lineClass: 'from-cyan-400/80 to-cyan-400/0',
    iconClass: 'text-cyan-400',
  },
  {
    icon: ArrowRightLeft,
    title: '规则二 · 合力流动',
    text: '每个邻面上，压力合力推动物质流动。流量取决于压差与粘稠度，并被严格限制——流动之后，压力绝不会反向。',
    formula: 'flow = Δp × (1 − viscosity)，且 flow ≤ min(源质量, 压差平衡量)',
    diagram: DiagramFlow,
    lineClass: 'from-blue-500/80 to-blue-500/0',
    iconClass: 'text-blue-400',
  },
  {
    icon: ArrowDownToLine,
    title: '规则三 · 永恒重力',
    text: '每个方格天然地对下方邻居施加等于重力的压力。正是这条规则让水向下坠落、在低处堆积、沿容器摊平。',
    formula: 'p↓ += mass × gravity',
    diagram: DiagramGravity,
    lineClass: 'from-emerald-400/80 to-emerald-400/0',
    iconClass: 'text-emerald-400',
  },
];

/** 模拟规则图解（S4） */
export default function Rules() {
  return (
    <section id="rules" className="max-w-[1600px] mx-auto px-4 md:px-8 py-16 md:py-24 scroll-mt-16">
      <motion.div
        initial={{ opacity: 0, y: 24 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, amount: 0.2 }}
        transition={{ duration: 0.6, ease: EASE }}
      >
        <p className="font-mono text-xs tracking-[0.3em] text-cyan-400">HOW IT WORKS</p>
        <h2 className="mt-3 text-2xl md:text-3xl font-bold">三条规则，一个世界</h2>
        <p className="mt-3 text-muted-foreground max-w-2xl leading-relaxed">
          没有 Navier-Stokes 方程，没有粒子系统——每个方格只做三件简单的事。
        </p>
      </motion.div>

      <div className="mt-10 grid grid-cols-1 md:grid-cols-3 gap-5">
        {CARDS.map((card, i) => (
          <motion.div
            key={card.title}
            initial={{ opacity: 0, y: 40 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.15 }}
            transition={{ duration: 0.6, ease: EASE, delay: i * 0.15 }}
            whileHover={{ y: -6 }}
            className="group"
          >
            <GlassPanel className="relative p-6 h-full overflow-hidden">
              {/* 顶部 3px 渐变线，hover 提亮 */}
              <div
                className={cn(
                  'absolute top-0 inset-x-0 h-[3px] bg-gradient-to-r transition-opacity duration-300 opacity-60 group-hover:opacity-100',
                  card.lineClass,
                )}
              />
              <card.icon
                size={24}
                className={cn(
                  'transition-transform duration-300 group-hover:scale-110 group-hover:rotate-6',
                  card.iconClass,
                )}
              />
              <h3 className="mt-4 text-lg font-semibold">{card.title}</h3>
              <div className="my-5 flex items-center justify-center min-h-[72px]">
                <card.diagram />
              </div>
              <p className="text-sm text-muted-foreground leading-relaxed">{card.text}</p>
              <code className="mt-5 block font-mono text-xs bg-white/5 rounded-md px-3 py-2 text-cyan-100/80">
                {card.formula}
              </code>
            </GlassPanel>
          </motion.div>
        ))}
      </div>
    </section>
  );
}
