/**
 * 帮手线程：模拟宿主（sim.worker）开出来的，和它共用一块内存，算网格里分给它的那几行（见 parPool.ts）。
 * 收到 init 先热身（引擎的代码先在小网格上编译好），然后一直睡在栅栏上等活
 */
import { helperLoop } from "./parPool";
import type { ParInit } from "./parPool";
import { FluidEngineBlob } from "./engineBlob";
import { applyPreset } from "./presets";

function warmUp(): void {
  for (const p of ["dam", "twin", "rain", "hourglass"] as const) {
    const e = new FluidEngineBlob(48, 48);
    applyPreset(e, p);
    e.mass[10 * 48 + 38] = 8;
    for (let s = 0; s < 120; s++) e.step();
  }
}

const scope = self as unknown as { onmessage: ((ev: MessageEvent<ParInit>) => void) | null };
scope.onmessage = (ev) => {
  scope.onmessage = null;
  warmUp();
  helperLoop(ev.data);
};
