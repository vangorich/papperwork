// Adapt the *pinned local* Emscripten glue at bundling time, not with runtime eval or importScripts.
// The caller supplies the shipped WASM bytes. No second Worker, URL resolution or filesystem access.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const name = 'virtual:paperwork-qpdf'
export function offlineQpdf() {
  return { name: 'paperwork-offline-qpdf', resolveId(id) { if (id === name) return '\0'+name },
    load(id) {
      if(id !== '\0'+name) return
      const glue = readFileSync(require.resolve('qpdf-run/qpdf.js'), 'utf8')
      return `export function openEngine(binary) { return new Promise((resolve,reject)=>{
      const process=undefined, require=undefined;
      let errors=[]; var Module={noInitialRun:true,wasmBinary:binary,thisProgram:'qpdf',print:()=>{},printErr:s=>errors.push(String(s)),onAbort:msg=>reject(Error(String(msg))),onRuntimeInitialized(){resolve({run(inputs,args,outputs){
        errors=[];const names=[...Object.keys(inputs),...outputs];try{for(const [name,data] of Object.entries(inputs))FS.createDataFile('/',name,data,true,false);
        const status=callMain([...args]);if(status!==0 || errors.some(s=>/warning:/i.test(s))) throw Error(errors.some(s=>/password|encrypted/i.test(s))?'加密 PDF 无法安全压缩':'PDF 结构异常，未生成副本');
        return Object.fromEntries(outputs.map(name=>[name,FS.readFile(name)]))
        }finally{for(const n of names){if(FS.analyzePath(n).exists)FS.unlink(n)}}
      }})}};
      ${glue}\n})}`
    } }
}
