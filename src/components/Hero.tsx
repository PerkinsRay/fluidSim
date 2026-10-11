import { useEffect, useRef } from 'react'
import { motion } from 'framer-motion'
import { makePreviewFrame } from '@/sim/render'

const EASE = [0.22, 1, 0.36, 1] as [number, number, number, number];

/** 迷你预览画布：用同一渲染管线预生成一帧模拟中期的流体形态 */
function MiniPreview() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const frame = makePreviewFrame('dam', 48, 48, 500);
    const off = document.createElement('canvas');
    off.width = frame.width;
    off.height = frame.height;
    off.getContext('2d')!.putImageData(frame, 0, 0);
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(off, 0, 0, canvas.width, canvas.height);
  }, []);

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.92 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.7, ease: EASE, delay: 0.5 }}
      className="hidden lg:block rounded-xl border border-subtle overflow-hidden animate-[previewGlow_4s_ease-in-out_infinite]"
      style={{ boxShadow: '0 0 24px rgba(34,211,238,0.2)' }}
    >
      <canvas ref={ref} width={120} height={120} style={{ width: 120, height: 120, imageRendering: 'pixelated' }} />
      <style>{`@keyframes previewGlow { 0%,100% { box-shadow: 0 0 24px rgba(34,211,238,0.15); } 50% { box-shadow: 0 0 32px rgba(34,211,238,0.35); } }`}</style>
    </motion.div>
  );
}

/** Hero 标题条（S2，紧凑型） */
export default function Hero() {
  const item = (delay: number) => ({
    initial: { opacity: 0, y: 20 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.6, ease: EASE, delay },
  });

  return (
    <section className="max-w-[1600px] mx-auto px-4 md:px-8 pt-12 pb-8">
      <div className="flex items-end justify-between gap-8">
        <div>
          <motion.span
            {...item(0.2)}
            className="inline-block rounded-full border border-cyan-400/30 bg-cyan-400/10 px-3 py-1 text-xs text-cyan-300"
          >
            元胞自动机 · 压力扩散模型
          </motion.span>
          <motion.h1
            {...item(0.32)}
            className="mt-4 text-4xl md:text-5xl font-bold tracking-tight"
          >
            方格之间，
            <span className="bg-gradient-to-r from-cyan-300 to-blue-500 bg-clip-text text-transparent bg-[size:200%_auto] animate-gradient-pan">
              流体
            </span>
            自生
          </motion.h1>
          <motion.p
            {...item(0.44)}
            className="mt-4 text-base text-muted-foreground max-w-xl leading-relaxed"
          >
            只有三条规则的方格世界：压力反作用、合力流动、永恒重力。画一笔水，看它坠落、堆积、摊平。
          </motion.p>
        </div>
        <MiniPreview />
      </div>
    </section>
  );
}
