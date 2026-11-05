# npm-toolchain

The GitHub repository contains only `packages.txt`, scripts and workflow. **Do not upload internal source, package.json, or bun.lock.**

1. Edit `packages.txt` with public `name@exact-version` entries. Push changes to this dedicated public-dependency export repository.
2. Run Actions -> Export public Bun dependencies -> Run workflow.
3. Download artifact `bun-registry-export`, extract its `bun-registry-export.tar.gz`.
4. In the airgapped environment with Bun and access to Gitea, run:

```bash
mkdir -p bun-import && cd bun-import
tar -xzf ../bun-registry-export.tar.gz
export GITEA_TOKEN='...'
bash import.sh
```

Override target with `GITEA_REGISTRY=https://.../api/packages/js/npm/`.

## Scope and limitations

- Bun resolves transitive dependencies from a **synthetic** package.json generated from the public allowlist; this does not reproduce an internal bun.lock exactly. Validate offline against the internal lockfile after importing.
- Platform-specific optional dependencies may be absent when resolution occurs on the GitHub Linux runner. Include needed platform variants explicitly in packages.txt, or use multiple resolution platforms.
- Git URLs, local/workspace dependencies, aliases and unusual registry specifications are not supported by this exporter; it fails rather than silently omitting unexpected resolved package forms.
- External binary downloads in postinstall are not mirrored.
- The importer uses Bun's npm-compatible publish API; test with a small package set before production use.
- Token and public registry configuration are only needed on the importing machine. The archive contains no secrets.
