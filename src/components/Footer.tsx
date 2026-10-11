import { motion } from 'framer-motion'
import { Github, Codepen, Info } from 'lucide-react'

export default function Footer() {
  return (
    <footer id="about" className="relative border-t border-subtle">
      {/* 顶部 1px 渐变发光线，滚动到底时 scaleX 展开 */}
      <motion.div
        initial={{ scaleX: 0 }}
        whileInView={{ scaleX: 1 }}
        viewport={{ once: true, amount: 0.5 }}
        transition={{ duration: 0.8, ease: 'easeOut' }}
        className="absolute -top-px inset-x-0 h-px bg-gradient-to-r from-transparent via-cyan-400/60 to-transparent origin-center"
      />
      <motion.div
        initial={{ opacity: 0 }}
        whileInView={{ opacity: 1 }}
        viewport={{ once: true, amount: 0.5 }}
        transition={{ duration: 0.5 }}
        className="max-w-[1600px] mx-auto px-4 md:px-8 py-8 flex flex-col md:flex-row items-center justify-between gap-3"
      >
        <p className="text-xs text-muted-foreground">
          © 2025 方格流体实验室 · Cellular Fluid Lab
        </p>
        <p className="text-xs text-muted-foreground font-mono text-center">
          规则驱动的元胞模拟 —— 不求解 Navier-Stokes，只遵循三条局部规则
        </p>
        <div className="flex items-center gap-4">
          <a href="https://github.com" target="_blank" rel="noreferrer" aria-label="GitHub"
            className="text-muted-foreground hover:text-cyan-300 transition-colors duration-200">
            <Github size={18} />
          </a>
          <a href="https://codepen.io" target="_blank" rel="noreferrer" aria-label="Codepen"
            className="text-muted-foreground hover:text-cyan-300 transition-colors duration-200">
            <Codepen size={18} />
          </a>
          <a href="#rules" aria-label="关于"
            className="text-muted-foreground hover:text-cyan-300 transition-colors duration-200">
            <Info size={18} />
          </a>
        </div>
      </motion.div>
    </footer>
  )
}
