/**
 * 主线程这一侧：把命令发给模拟宿主（Web Worker，见 sim.worker.ts），收最新一帧给渲染器。
 *   - EngineView：最新一帧的数据，长得像引擎（w、h、cell、mass、kind、renderDensity…），renderEngine 直接画它
 *   - SimClient：命令（run / preset / paint …）+ 取帧 + ack
 * 浏览器没有 Worker 时，宿主直接跑在主线程里（同一套消息，只是不并行）。
 */
import { CELL_FLUID, DEFAULT_PARAMS, cellSizeFor } from "./engine";
import type { SimParams } from "./engine";
import type { CellProbe } from "./engineBlob";
import type { PresetKey } from "./presets";
import type { RenderSource } from "./render";
import { SimHost, makeScheduler } from "./simHost";
import { parAvailable, pickThreads } from "./parPool";
import type { FrameBufs, SimFrame, SimIn } from "./simHost";
import type { Tool } from "./controller";

export class EngineView implements RenderSource {
  w = 0;
  h = 0;
  cell = 1;
  mass = new Float32Array(0);
  kind = new Uint8Array(0);
  rho = new Float32Array(0);
  blocks: Float32Array | null = null;
  steps = 0;
  totalMass = 0;
  floor = 0;
  probe: CellProbe | null = null;
  /** Worker 里一步的耗时（ms） */
  stepMs = 0;
  /** 实际在用几个线程算模拟、为什么没用上多线程 */
  threads = 1;
  why = "";

  /** 换网格：尺寸立刻变（画布按它重建），内容等第一帧 */
  resize(size: number): void {
    this.w = this.h = size;
    this.cell = cellSizeFor(size, size);
    this.mass = new Float32Array(size * size);
    this.rho = new Float32Array(size * size);
    this.kind = new Uint8Array(size * size).fill(CELL_FLUID);
    this.blocks = null;
    this.probe = null;
  }

  renderDensity(): ArrayLike<number> {
    return this.rho;
  }

  renderBlocks(): Float32Array | null {
    return this.blocks;
  }

  get pixelWidth(): number {
    return this.w * this.cell;
  }

  get pixelHeight(): number {
    return this.h * this.cell;
  }
}

export class SimClient {
  readonly view = new EngineView();
  /** 当前参数（UI 的初始值从这里读；改动同时发给宿主） */
  readonly params: SimParams = { ...DEFAULT_PARAMS };
  /** 是否真的跑在 Worker 里（没有 Worker 时为 false） */
  readonly threaded: boolean;
  private readonly send: (m: SimIn) => void;
  /** 带转移列表的发送（只有 Worker 用） */
  private readonly post: (m: SimIn, tr: Transferable[]) => void;
  /** 逻辑核数（浏览器给的 navigator.hardwareConcurrency；拿不到按 4）、打算用几个线程算模拟、几个线程画画面 */
  readonly cores: number;
  readonly simThreads: number;
  readonly renderThreads: number;
  /** 为什么没打算用多线程（打算用就是空字符串） */
  readonly whyNoPar: string;
  private gen = 0;
  /** 算好、还没画的帧，按顺序（两份缓冲，所以最多 2 个） */
  private queue: SimFrame[] = [];
  private blocks: boolean;

  constructor(size: number, preset: PresetKey | "", blocks: boolean) {
    this.blocks = blocks;
    const onFrame = (f: SimFrame) => {
      if (f.gen !== this.gen) return; // 旧网格的帧：丢掉（宿主换网格时已经不算它了）
      // 排队，一帧都不跳：宿主最多领先一帧（两份缓冲），新帧要等前面那帧画完、还回去才会来
      this.queue.push(f);
    };
    let send: ((m: SimIn) => void) | null = null;
    let post: ((m: SimIn, tr: Transferable[]) => void) | null = null;
    if (typeof Worker !== "undefined") {
      try {
        const worker = new Worker(new URL("./sim.worker.ts", import.meta.url), { type: "module" });
        worker.onmessage = (ev: MessageEvent<SimFrame>) => onFrame(ev.data);
        send = (m) => worker.postMessage(m);
        post = (m, tr) => worker.postMessage(m, tr);
      } catch {
        send = null;
      }
    }
    this.threaded = send !== null;
    const nav = (globalThis as { navigator?: { hardwareConcurrency?: number } }).navigator;
    this.cores = nav?.hardwareConcurrency || 4;
    // 网址里加 ?threads=1 强制单线程、?threads=4 强制 4 个（排查用）；不加就按核数自动选
    const loc = (globalThis as { location?: { search?: string } }).location;
    const forced = Number(new URLSearchParams(loc?.search ?? "").get("threads") || 0);
    const can = this.threaded && parAvailable();
    this.simThreads = !can ? 1 : forced >= 1 ? Math.min(forced, 8) : pickThreads(this.cores);
    // 画画面的线程：模拟占满以后多出来的核（留 2 个给主线程和浏览器），最多 4 个；网址里 ?render=0 关掉、?render=3 定成 3 个。
    // 核不够时不开（主线程自己画）—— 和模拟抢核只会两边都慢
    const forcedR = new URLSearchParams(loc?.search ?? "").get("render");
    const spare = this.cores - 2 - this.simThreads;
    this.renderThreads = !can ? 0 : forcedR !== null ? Math.max(0, Math.min(8, Number(forcedR) || 0)) : spare >= 2 ? Math.min(4, spare) : 0;
    // 跨源隔离只在安全来源（https:// 或 localhost）上生效：用 http://IP:端口 打开时浏览器直接忽略 COOP / COEP 头
    const secure = (globalThis as { isSecureContext?: boolean }).isSecureContext !== false;
    this.whyNoPar = !this.threaded
      ? "没有 Web Worker"
      : !can
        ? !secure
          ? "不是安全来源（http:// 加 IP / 主机名）：浏览器忽略跨源隔离头，用不了共享内存。用 https://，或者用 localhost 打开（远程机器可以 ssh -L 3000:localhost:3000 转发）"
          : "页面没有跨源隔离（服务器要发 COOP / COEP 响应头），用不了共享内存"
        : this.simThreads < 2
          ? forced === 1
            ? "网址里 ?threads=1"
            : "核数太少"
          : "";
    if (!send) {
      // 同一线程：数组不能还（宿主那边的帧就是这些数组的唯一引用，下一帧会新分配）
      const host = new SimHost((f) => onFrame(f), makeScheduler());
      send = (m) => host.handle(m);
    }
    this.send = send;
    this.post = post ?? ((m) => this.send(m));
    this.init(size, preset);
  }

  /** 新建网格（换分辨率也走这里）：参数沿用当前的 */
  init(size: number, preset: PresetKey | ""): void {
    this.gen++;
    this.queue.length = 0;
    this.view.resize(size);
    this.send({ t: "init", gen: this.gen, size, params: { ...this.params }, preset, blocks: this.blocks, threads: this.simThreads });
  }

  /** 有新的一帧：写进 view，返回 true（画完记得 ack） */
  /** 下一帧算好了：写进 view（按顺序，最早的那帧），返回 true（画完记得 ack）；还没算好返回 false —— 这次不画，等 */
  takeFrame(): boolean {
    const f = this.queue.shift();
    if (!f) return false;
    const v = this.view;
    v.mass = f.mass;
    v.rho = f.rho;
    v.kind = f.kind;
    v.blocks = f.blocks;
    v.steps = f.steps;
    v.totalMass = f.totalMass;
    v.floor = f.floor;
    v.probe = f.probe;
    v.stepMs = f.stepMs;
    v.threads = f.threads;
    if (f.why && f.why !== v.why) console.warn("多线程没用上：" + f.why);
    v.why = f.why;
    return true;
  }

  /**
   * 这一帧画完了：把它的数组还给宿主复用（转移走之后 view 里的数组就不能再读了 ——
   * 渲染器只在 renderEngine 里读，画完才 ack）
   */
  ack(): void {
    const v = this.view;
    this.giveBack({ mass: v.mass, rho: v.rho, kind: v.kind, blocks: v.blocks });
  }

  private giveBack(b: FrameBufs): void {
    const back = { mass: b.mass, rho: b.rho, kind: b.kind, blocks: b.blocks };
    if (!this.threaded) {
      this.send({ t: "ack", gen: this.gen, back });
      return;
    }
    const tr: Transferable[] = [back.mass.buffer, back.rho.buffer, back.kind.buffer];
    if (back.blocks) tr.push(back.blocks.buffer);
    this.post({ t: "ack", gen: this.gen, back }, tr);
  }

  run(on: boolean): void {
    this.send({ t: "run", on });
  }

  speed(v: number): void {
    this.send({ t: "speed", v });
  }

  param(key: keyof SimParams, v: number): void {
    this.params[key] = v;
    this.send({ t: "param", key, v });
  }

  preset(p: PresetKey): void {
    this.send({ t: "preset", preset: p });
  }

  clear(): void {
    this.send({ t: "clear" });
  }

  step(): void {
    this.send({ t: "step" });
  }

  beginStroke(): void {
    this.send({ t: "stroke" });
  }

  /** 一串画刷落点（x, y, x, y, …，格坐标），一条消息发过去 */
  paint(tool: Tool, pts: number[], r: number): void {
    if (pts.length) this.send({ t: "paint", tool, pts, r });
  }

  /** 悬停读数要看哪一格（-1 = 不看） */
  probeAt(x: number, y: number): void {
    this.send({ t: "probe", x, y });
  }
}
