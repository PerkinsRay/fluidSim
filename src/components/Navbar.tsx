import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { Github } from 'lucide-react'
import { cn } from '@/lib/utils'

const LINKS = [
  { href: '#simulator', label: '模拟器' },
  { href: '#about', label: '关于' },
]

/** Logo：3×3 方格 SVG，中心格 cyan 发光，其余描边 */
function LogoGrid() {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden>
      {Array.from({ length: 9 }, (_, i) => {
        const cx = (i % 3) * 9 + 1;
        const cy = Math.floor(i / 3) * 9 + 1;
        const center = i === 4;
        return (
          <rect
            key={i}
            x={cx}
            y={cy}
            width="7"
            height="7"
            rx="1"
            fill={center ? '#22D3EE' : 'none'}
            stroke={center ? '#22D3EE' : '#64748B'}
            strokeWidth="1"
            style={center ? { filter: 'drop-shadow(0 0 6px #22D3EE)' } : undefined}
          />
        );
      })}
    </svg>
  );
}

export default function Navbar() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 40);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <motion.header
      initial={{ y: -56, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.5, ease: 'easeOut', delay: 0.1 }}
      className={cn(
        'sticky top-0 z-50 h-14 border-b backdrop-blur-md transition-all duration-300',
        scrolled
          ? 'bg-[#0D1420]/90 border-[rgba(148,163,184,0.28)]'
          : 'bg-[#0D1420]/70 border-subtle',
      )}
    >
      <div className="max-w-[1600px] mx-auto px-4 md:px-8 h-full flex items-center justify-between">
        <a href="#top" className="flex items-center gap-2.5">
          <LogoGrid />
          <span className="flex flex-col leading-none">
            <span className="text-sm font-bold">方格流体实验室</span>
            <span className="font-mono text-[10px] tracking-[0.25em] text-muted-foreground mt-1">
              CELLULAR FLUID LAB
            </span>
          </span>
        </a>

        <nav className="flex items-center gap-6">
          <div className="hidden md:flex items-center gap-6">
            {LINKS.map((l) => (
              <a
                key={l.href}
                href={l.href}
                className="group relative text-sm text-muted-foreground hover:text-foreground transition-colors duration-200"
              >
                {l.label}
                <span className="absolute -bottom-1 left-0 h-[2px] w-full bg-cyan-400 origin-left scale-x-0 group-hover:scale-x-100 transition-transform duration-300" />
              </a>
            ))}
          </div>
          <a
            href="https://github.com"
            target="_blank"
            rel="noreferrer"
            aria-label="GitHub"
            className="text-muted-foreground hover:text-cyan-300 transition-colors duration-200"
          >
            <Github size={20} />
          </a>
        </nav>
      </div>
    </motion.header>
  );
}
