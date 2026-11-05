# Public Bun dependencies -> Gitea npm registry

This repository is PUBLIC-ONLY. Never upload corporate frontend source, package.json, bun.lock, or internal module names.

## Export

Edit `packages.txt` (`name|selector|argument`) and run GitHub Actions `Export public Bun dependencies` via workflow_dispatch. Download artifact `bun-registry-export`; it contains `bun-registry-export.tar.gz`.

Selectors:
- `latest` = highest stable numeric `X.Y.Z` version (resolved before export)
- `major|5,6,7,8` = highest stable version of each available major
- `yearly|2022-01-01..2026-11-05` = highest stable patch per minor for releases **published within that date window**
- `exact|X.Y.Z` = one exact version

The exporter uses npmjs.org public metadata, Bun to resolve each selected root's transitive dependency tree independently, downloads original `.tgz` and checks upstream SRI. It fails on unsupported Git/file/prerelease transitive packages rather than silently producing an incomplete export. This can produce a large archive and many resolution steps. The public manifest contains only package names/versions and hashes.

## Import

```bash
mkdir import && cd import
tar -xzf ../bun-registry-export.tar.gz
export GITEA_TOKEN='YOUR_BOT_TOKEN'
bash import.sh
```

Needs Bun, Bash, sha256sum and a trusted HTTPS certificate. Target defaults to `https://registry.tsniimash.ru:3001/api/packages/js/npm/`. Override with `GITEA_REGISTRY`.

`import.sh` uses `bun publish --tolerate-republish --tag imported`. **Caveat:** npm-compatible registries/Bun may still create `latest` for the first publication of a package. Exact package versions in manifest are guaranteed; complete absence of dist-tags is **not**. You must inspect/clean dist-tags in Gitea if this is a hard policy. The script does not pretend to enforce it.

## Scope and limitations

- Does not contain internal code or internal lockfiles.
- Separate dependency resolution per root handles incompatible major versions; however it does not reproduce a private project lockfile exactly.
- Uses `bun install --lockfile-only --ignore-scripts`, never npm CLI or Node CLI.
- Registry is for browser build dependencies; native build-time tools (esbuild etc.) may still need platform-specific optional packages.
- Lockfile's registry metadata may include nonregistry URLs; these cause export to fail rather than be silently ignored.
- The selected `yearly` policy is last patch of each minor **published in the window**, not every version published in the period.
- No live end-to-end run against your Gitea was performed. First test with a small packages.txt.
