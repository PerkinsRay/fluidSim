const ts=require('/usr/lib/code-server/node_modules/typescript');const fs=require('fs');
const base=fs.readFileSync('/home/pengkun/sim/new/src/sim/engineSimple.ts','utf8');
const rep=(t,a,b)=>{if(!t.includes(a))throw new Error('miss: '+a.slice(0,50));return t.split(a).join(b);};
const IMP='import { fluxRatio } from "./plic";';
const G=`          // 重力是体力：作用在上方那格的水上（它要往下掉），动量增量 g·m_i
          fvNext[i] = this.limitP(
            P0 + ((msrc > 1e-9 ? F : 0) + g * mi) * dt,`;
const V={};
// 重力的 m 用 PLIC 带密度封顶：只算"真正压在下面那个面上"的那部分水。
// 带密度 = bandMass(下, d)/d，均匀满格时恰好 = m_i（满格行为不变）。
for(const d of ['0.25','0.5','1']){
  let t=rep(base,IMP,'import { fluxRatio, bandMass } from "./plic";');
  t=rep(t,G,`          // 重力是体力，动量增量 g·m_i —— 但 m_i 要被 PLIC 封顶：
          // 界面格里的水只占格子的一部分，贴在上半格的水并没有压在下面那个面上，
          // 整格质量会高估它。带密度 = bandMass(下, d)/d，均匀满格时恰好等于 m_i。
          const gm =
            m0 > 0 && mi > 0 && mi < m0
              ? Math.min(mi, bandMass(mass, kind, w, h, i, 1, ${d}, m0) / ${d})
              : mi;
          fvNext[i] = this.limitP(
            P0 + ((msrc > 1e-9 ? F : 0) + g * gm) * dt,`);
  V['gp'+d.replace('.','')]=t;
}
const out=(c)=>ts.transpileModule(c,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2020}}).outputText.replace(/from ["']\.\/engine["']/g,"from './engine.mjs'").replace(/from ["']\.\/plic["']/g,"from './plic.mjs'");
for(const[k,c] of Object.entries(V)){fs.writeFileSync(`/tmp/rot/m/${k}.mjs`,out(c));fs.writeFileSync(`/tmp/rot/${k}.ts`,c);}
console.log('built '+Object.keys(V).join(' '));
