#!/usr/bin/env bun
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, createHmac } from 'node:crypto';

const root = resolve(import.meta.dir, '..');
const out = join(root, 'dist');
const stage = join(out, 'transfer');
rmSync(out, { recursive: true, force: true });
mkdirSync(join(stage, 'tgz'), { recursive: true });
const registry = 'https://registry.npmjs.org';
const metadataCache = new Map();
const exact = /^\d+\.\d+\.\d+$/;
const stable = v => exact.test(v);
const cmp = (a,b) => { const x=a.split('.').map(Number), y=b.split('.').map(Number); for(let i=0;i<3;i++) if(x[i]!==y[i]) return x[i]-y[i]; return 0; };
function packagePath(name) { return encodeURIComponent(name); }
async function metadata(name) {
  if (!metadataCache.has(name)) {
    const r=await fetch(`${registry}/${packagePath(name)}`);
    if(!r.ok) throw new Error(`Metadata ${name}: HTTP ${r.status}`);
    metadataCache.set(name, await r.json());
  }
  return metadataCache.get(name);
}
async function choose(name, kind, arg) {
  const meta=await metadata(name);
  const versions=Object.keys(meta.versions).filter(stable).sort(cmp);
  if(kind==='exact') { if(!meta.versions[arg] || !stable(arg)) throw new Error(`${name}@${arg} missing/not stable`); return [arg]; }
  if(kind==='latest') { if(!versions.length) throw new Error(`${name}: no stable versions`); return [versions.at(-1)]; }
  if(kind==='major') {
    const selected=[];
    for(const m of arg.split(',').map(x=>x.trim())) {
      const v=versions.filter(v=>v.split('.')[0]===m).at(-1);
      if(v) selected.push(v); else console.warn(`WARN ${name}: no stable ${m}.x`);
    }
    if(!selected.length) throw new Error(`${name}: no requested major available`);
    return selected;
  }
  if(kind==='yearly') {
    const match=/^(\d{4}-\d\d-\d\d)\.\.(\d{4}-\d\d-\d\d)$/.exec(arg);
    if(!match) throw new Error(`Invalid date range: ${arg}`);
    const [_,start,end]=match;
    const byMinor=new Map();
    for(const v of versions) {
      const date=meta.time?.[v]?.slice(0,10);
      if(!date || date<start || date>end) continue;
      const key=v.split('.').slice(0,2).join('.');
      const prev=byMinor.get(key);
      if(!prev || cmp(v,prev)>0) byMinor.set(key,v);
    }
    if(!byMinor.size) throw new Error(`${name}: no stable releases during ${arg}`);
    return [...byMinor.values()].sort(cmp);
  }
  throw new Error(`Unknown selector ${kind}`);
}
async function run(cmd,args,opts={}) {
  const proc=Bun.spawn([cmd,...args],{cwd:opts.cwd??root,env:{...process.env,...opts.env},stdout:'pipe',stderr:'pipe'});
  const [stdout,stderr,code]=await Promise.all([new Response(proc.stdout).text(),new Response(proc.stderr).text(),proc.exited]);
  if(code!==0) throw new Error(`${cmd} ${args.join(' ')} failed (${code}):\n${stderr}\n${stdout}`);
  return stdout;
}
const roots=[];
for(const [idx,line] of readFileSync(join(root,'packages.txt'),'utf8').split(/\r?\n/).entries()) {
  const s=line.trim(); if(!s||s.startsWith('#')) continue;
  const parts=s.split('|'); if(parts.length!==3) throw new Error(`packages.txt line ${idx+1}: expected name|selector|arg`);
  const [name,kind,arg]=parts.map(s=>s.trim());
  for(const v of await choose(name,kind,arg)) roots.push([name,v]);
}
const selected=new Map();
for(const [name,v] of roots) selected.set(`${name}@${v}`,[name,v]);
console.log(`Root package versions: ${selected.size}`);
// Resolve each root independently: incompatible RxJS/TypeScript majors can coexist in the export.
for(const [name,version] of selected.values()) {
  const work=mkdtempSync(join(tmpdir(),'bun-resolve-'));
  try {
    writeFileSync(join(work,'package.json'),JSON.stringify({name:'public-deps-export',version:'0.0.0',private:true,dependencies:{[name]:version}}));
    await run('bun',['install','--lockfile-only','--ignore-scripts','--no-progress'],{cwd:work,env:{BUN_CONFIG_REGISTRY:registry}});
    const lock=Bun.JSONC.parse(readFileSync(join(work,'bun.lock'),'utf8'));
    for(const item of Object.values(lock.packages??{})) {
      if(!Array.isArray(item)||typeof item[0]!=='string') continue;
      const spec=item[0];
      const at=spec.lastIndexOf('@');
      if(at<=0) continue;
      const n=spec.slice(0,at), v=spec.slice(at+1);
      if(!stable(v)) {
        if (/^(?:workspace:|file:|link:)/.test(v)) continue;
        throw new Error(`Non-registry or prerelease dependency in lock: ${spec}`);
      }
      selected.set(`${n}@${v}`,[n,v]);
    }
  } finally { rmSync(work,{recursive:true,force:true}); }
}
console.log(`Resolved total package versions: ${selected.size}`);
const manifest=['name\tversion\tfile\tsha256\tsha512'];
let index=0;
for(const [name,version] of [...selected.values()].sort((a,b)=>a[0].localeCompare(b[0])||cmp(a[1],b[1]))) {
  const meta=await metadata(name);
  const dist=meta.versions?.[version]?.dist;
  if(!dist?.tarball || !dist?.integrity) throw new Error(`No integrity/tarball: ${name}@${version}`);
  const url=new URL(dist.tarball);
  if(url.protocol!=='https:'||url.hostname!=='registry.npmjs.org') throw new Error(`Unexpected tarball host ${url}: ${name}@${version}`);
  const response=await fetch(url);
  if(!response.ok) throw new Error(`Tarball ${name}@${version}: ${response.status}`);
  const bytes=Buffer.from(await response.arrayBuffer());
  const hashes=dist.integrity.split(/\s+/);
  const sri=hashes.find(x=>x.startsWith('sha512-'))??hashes.find(x=>x.startsWith('sha1-'));
  if(!sri) throw new Error(`Unsupported integrity ${name}@${version}`);
  const [algorithm,expected]=sri.split('-',2);
  const actual=createHash(algorithm).update(bytes).digest('base64');
  if(actual!==expected) throw new Error(`Integrity mismatch ${name}@${version}`);
  const sha256=createHash('sha256').update(bytes).digest('hex');
  const filename=`tgz/${String(index++).padStart(6,'0')}.tgz`;
  writeFileSync(join(stage,filename),bytes);
  manifest.push(`${name}\t${version}\t${filename}\t${sha256}\t${dist.integrity}`);
  if(index%25===0) console.log(`Downloaded ${index}/${selected.size}`);
}
writeFileSync(join(stage,'manifest.tsv'),manifest.join('\n')+'\n');
copyFileSync(join(root,'scripts','import.sh'),join(stage,'import.sh'));
await run('tar',['-czf',join(out,'bun-registry-export.tar.gz'),'-C',stage,'.']);
console.log(`DONE: ${join(out,'bun-registry-export.tar.gz')} (${index} tarballs)`);
