# npm-toolchain

Copy `.github/workflows/export-bun-registry.yml` and `scripts/collect.mjs` to the frontend repository. Keep `scripts/import.sh` there too.

The repository must have a committed text `bun.lock` (Bun >=1.2). Run the GitHub Action. It outputs `bun-registry-export.tar.gz` inside the GitHub Actions artifact. No registry token is needed on GitHub.

On a machine with access to Gitea and Bun:

```sh
mkdir bun-registry-export && cd bun-registry-export
tar -xzf ../bun-registry-export.tar.gz
export GITEA_TOKEN='your-package-write-token'
./import.sh
```

Override `GITEA_REGISTRY` if necessary. The importer is idempotent with `--tolerate-republish` and verifies SHA-256 for each tarball before publishing. Failures are reported with a nonzero exit code; rerun after fixing the cause.

**Scope:** registry semver packages from `bun.lock` only, including optional platform packages and transitive dependencies. Workspace/file/link dependencies are intentionally skipped; git and direct tarball dependencies fail fast (must be treated separately). Original registry tarballs are preserved, and integrity from the lockfile is checked when present. External postinstall downloads and git dependencies are not mirrored. This is not an on-demand npm proxy.

**Important:** Some lockfiles pin external registry URLs. For offline client builds, verify that `bun.lock` resolves through Gitea rather than `registry.npmjs.org` and avoid running with an old warm cache during acceptance testing. Also check dist-tags: imported versions may get `latest` tags in publication order, so prefer frozen lockfiles / explicit versions.
