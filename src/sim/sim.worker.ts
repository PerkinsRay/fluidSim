/**
 * Web Worker 入口：模拟在这个线程里跑，主线程只画画面（见 simHost.ts / simClient.ts）。
 */
import { SimHost, makeScheduler } from "./simHost";
import type { SimIn } from "./simHost";

const scope = self as unknown as {
  postMessage(m: unknown, transfer: Transferable[]): void;
  onmessage: ((ev: MessageEvent<SimIn>) => void) | null;
};

// 多线程模拟时的帮手线程（见 parPool.ts）
const spawn = () => new Worker(new URL("./par.worker.ts", import.meta.url), { type: "module" });
const host = new SimHost((f, transfer) => scope.postMessage(f, transfer), makeScheduler(), spawn);
scope.onmessage = (ev) => host.handle(ev.data);
