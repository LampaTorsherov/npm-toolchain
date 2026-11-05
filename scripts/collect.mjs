import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const [lockPath, out] = process.argv.slice(2);
const lock = Bun.JSONC.parse(readFileSync(lockPath, 'utf8'));
if (!lock || !lock.packages) throw new Error('Unexpected bun.lock format');
const found = new Map();
for (const [key, value] of Object.entries(lock.packages)) {
  if (!Array.isArray(value) || typeof value[0] !== 'string') continue;
  // Bun resolved registry entries start with package-name@semver.
  const m = value[0].match(/^(@[^/]+\/[^@]+|[^@/]+)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/);
  if (!m) {
    if (!String(value[0]).startsWith('workspace:')) throw new Error(`Unsupported resolved package ${key}: ${value[0]}`);
    continue;
  }
  found.set(`${m[1]}@${m[2]}`, {name:m[1], version:m[2]});
}
if (!found.size) throw new Error('No registry packages found in bun.lock');
const lines = ['file\tname\tversion\tsha256'];
let i = 0;
for (const item of [...found.values()].sort((a,b) => (a.name+a.version).localeCompare(b.name+b.version))) {
  const metadataURL = `https://registry.npmjs.org/${encodeURIComponent(item.name)}/${encodeURIComponent(item.version)}`;
  const metaResp = await fetch(metadataURL);
  if (!metaResp.ok) throw new Error(`Metadata HTTP ${metaResp.status}: ${metadataURL}`);
  const meta = await metaResp.json();
  if (meta.name !== item.name || meta.version !== item.version || !meta.dist?.tarball) throw new Error(`Bad metadata ${item.name}@${item.version}`);
  const tarballURL = new URL(meta.dist.tarball);
  if (tarballURL.protocol !== 'https:' || tarballURL.hostname !== 'registry.npmjs.org') throw new Error(`Unexpected tarball host: ${tarballURL}`);
  const resp = await fetch(tarballURL);
  if (!resp.ok) throw new Error(`Tarball HTTP ${resp.status}: ${tarballURL}`);
  const bytes = Buffer.from(await resp.arrayBuffer());
  if (meta.dist.integrity) {
    const [alg, digest] = meta.dist.integrity.split('-', 2);
    if (!['sha512','sha384','sha256'].includes(alg)) throw new Error(`Unsupported integrity: ${alg}`);
    if (createHash(alg).update(bytes).digest('base64') !== digest) throw new Error(`Integrity mismatch: ${item.name}@${item.version}`);
  } else if (meta.dist.shasum && createHash('sha1').update(bytes).digest('hex') !== meta.dist.shasum) {
    throw new Error(`SHA1 mismatch: ${item.name}@${item.version}`);
  }
  const file = `${String(i++).padStart(6,'0')}.tgz`;
  mkdirSync(join(out,'tgz'), {recursive:true});
  await Bun.write(join(out,'tgz',file), bytes);
  lines.push([file,item.name,item.version,createHash('sha256').update(bytes).digest('hex')].join('\t'));
  console.log(`${item.name}@${item.version}`);
}
writeFileSync(join(out,'manifest.tsv'),lines.join('\n')+'\n');
console.log(`Exported ${i} packages`);
