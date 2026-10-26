/**
 * 多线程画画面（主线程这一侧）：几个渲染 Worker 一起把一帧画进一块共享的像素（SharedArrayBuffer），
 * 主线程只把画好的像素拷进画布（putImageData）。
 *
 * 分工：每 RENDER_CHUNK 行一块，第 r 个 Worker 画第 r、r+R、r+2R… 块（轮流分小块）——
 * 画的工作量集中在水在动的那几行（水体内部、空气整块填，边缘逐像素），按大段分的话一两个线程包了所有的活。
 * 每个 Worker 画自己那几块（render.ts 的 renderRows：只读这几行和上下各一行，只写这几行的像素），
 * 和整张一起画逐像素相同。
 *
 * 一帧的数据（质量、密度、格类型）由主线程拷进一块共享的输入，Worker 只读它。
 * 主线程不能 Atomics.wait（会卡住页面），所以用消息：发"画第 n 帧"给每个 Worker，各自画完回一条消息，
 * 回齐了这一帧就画好了。画的时候主线程不等、照常跑（下一次刷新再看画好没）。
 *
 * 锁步不变：一帧画好、拷进画布之后才把数据缓冲还给模拟 Worker（见 SimulationCanvas）。
 */
import type { RowSource } from "./render";

/** 发给渲染 Worker 的消息 */
export type RenderIn =
  | { t: "init"; w: number; h: number; cell: number; input: SharedArrayBuffer; pixels: SharedArrayBuffer; idx: number; count: number }
  | { t: "draw"; no: number };

/** 渲染 Worker 回的消息：画完了第 no 帧 */
export interface RenderOut {
  t: "done";
  no: number;
  idx: number;
}

/** 每块几行（轮流分给各渲染 Worker） */
export const RENDER_CHUNK = 4;

/** 共享输入：质量（f32）、密度（f32）、格类型（u8），n 格 */
export function inputViews(buf: SharedArrayBuffer, n: number): { mass: Float32Array; rho: Float32Array; kind: Uint8Array } {
  return { mass: new Float32Array(buf, 0, n), rho: new Float32Array(buf, n * 4, n), kind: new Uint8Array(buf, n * 8, n) };
}

/** 能不能用（要共享内存：页面跨源隔离） */
export function renderPoolAvailable(): boolean {
  const g = globalThis as { crossOriginIsolated?: boolean; SharedArrayBuffer?: unknown };
  return typeof g.SharedArrayBuffer === "function" && g.crossOriginIsolated === true && typeof Worker !== "undefined";
}

/** 一帧要画的东西（EngineView 满足） */
export interface FrameSource extends RowSource {
  renderDensity(): ArrayLike<number>;
}

export class RenderPool {
  readonly count: number;
  /** 画好的像素（整张图，w·cell × h·cell 个 32 位像素；主线程拷进画布） */
  readonly pixels: Uint8ClampedArray;
  private readonly input: { mass: Float32Array; rho: Float32Array; kind: Uint8Array };
  private readonly workers: Worker[] = [];
  private no = 0;
  /** 这一帧还有几个 Worker 没画完（0 = 没在画 / 画完了） */
  private left = 0;
  /** 有 Worker 出错：之后主线程自己画（见 failed） */
  private broken = "";
  private readonly started = performance.now();
  private ready = 0;
  private drawStart = 0;

  constructor(w: number, h: number, cell: number, count: number) {
    this.count = count;
    const n = w * h;
    const inputBuf = new SharedArrayBuffer(n * 9);
    this.input = inputViews(inputBuf, n);
    const pixBuf = new SharedArrayBuffer(w * cell * h * cell * 4);
    this.pixels = new Uint8ClampedArray(pixBuf);
    for (let r = 0; r < count; r++) {
      const wk = new Worker(new URL("./render.worker.ts", import.meta.url), { type: "module" });
      wk.onmessage = (ev: MessageEvent<RenderOut | { t: "ready" }>) => {
        const m = ev.data;
        if (m.t === "ready") this.ready++;
        else if (m.no === this.no && this.left > 0) this.left--;
      };
      wk.onerror = (ev) => {
        if (!this.broken) {
          this.broken = "渲染线程出错：" + (ev.message || "（多半是脚本加载失败）");
          console.error(this.broken, ev);
        }
      };
      const msg: RenderIn = { t: "init", w, h, cell, input: inputBuf, pixels: pixBuf, idx: r, count };
      wk.postMessage(msg);
      this.workers.push(wk);
    }
  }

  /** 能用了吗（所有渲染 Worker 都起来了、没出错）；起不来 / 出错就一直用主线程自己画 */
  get usable(): boolean {
    if (this.broken) return false;
    if (this.ready < this.count) {
      if (performance.now() - this.started > 8000 && !this.broken) this.broken = "渲染线程 8 秒还没起来";
      return false;
    }
    return true;
  }

  /** 为什么没在用（在用就是空字符串） */
  get why(): string {
    return this.broken;
  }

  /** 正在画吗 */
  get busy(): boolean {
    return this.left > 0;
  }

  /** 交给渲染 Worker 画这一帧（拷数据进共享输入，马上返回）。调用前要 !busy */
  start(src: FrameSource): void {
    this.input.mass.set(src.mass as Float32Array);
    this.input.rho.set(src.renderDensity() as Float32Array);
    this.input.kind.set(src.kind as Uint8Array);
    this.no++;
    this.left = this.count;
    this.drawStart = performance.now();
    const msg: RenderIn = { t: "draw", no: this.no };
    for (const w of this.workers) w.postMessage(msg);
  }

  /**
   * 画完了吗：画完返回 true（像素可以拷了）。等太久（渲染线程被停掉 / 不调度）就判它坏了，
   * 返回 true 但 broken —— 调用方看 usable，自己重画这一帧
   */
  done(): boolean {
    if (this.left === 0) return true;
    if (performance.now() - this.drawStart > 1500) {
      this.broken = "渲染线程 1.5 秒没画完，改成主线程自己画";
      this.left = 0;
      return true;
    }
    return false;
  }

  dispose(): void {
    for (const w of this.workers) w.terminate();
    this.workers.length = 0;
  }
}
