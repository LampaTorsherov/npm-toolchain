import { readFileSync, writeFileSync } from 'node:fs';
const [source, dest] = process.argv.slice(2);
const deps = {};
for (const raw of readFileSync(source, 'utf8').split(/\r?\n/)) {
  const line = raw.trim();
  if (!line || line.startsWith('#')) continue;
  const m = line.match(/^(@[^/\s]+\/[^@\s]+|[^@\s/]+)@(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/);
  if (!m) throw new Error(`Invalid public package@version: ${line}`);
  if (deps[m[1]]) throw new Error(`Duplicate package: ${m[1]}`);
  deps[m[1]] = m[2];
}
if (!Object.keys(deps).length) throw new Error('Empty packages.txt');
writeFileSync(dest, JSON.stringify({name:'public-dependency-export',private:true,version:'0.0.0',dependencies:deps},null,2));
