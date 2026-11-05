#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
REGISTRY="${GITEA_REGISTRY:-https://registry.tsniimash.ru:3001/api/packages/js/npm/}"
: "${GITEA_TOKEN:?Set GITEA_TOKEN in environment}"
command -v bun >/dev/null || { echo 'bun required' >&2; exit 1; }
command -v sha256sum >/dev/null || { echo 'sha256sum required' >&2; exit 1; }
[[ -f manifest.tsv ]] || { echo 'manifest.tsv missing' >&2; exit 1; }
[[ "$REGISTRY" == https://* ]] || { echo 'HTTPS registry required' >&2; exit 1; }
# Explicit registry avoids third-party publishConfig.registry redirecting publication.
# Publish from tarball: no install/lifecycle scripts executed.
export NPM_CONFIG_TOKEN="$GITEA_TOKEN"
fail=0; ok=0
while IFS=$'\t' read -r name version file hash integrity; do
  [[ "$name" == name && "$version" == version ]] && continue
  [[ -n "$name" ]] || continue
  if [[ ! "$file" =~ ^tgz/[0-9]{6}\.tgz$ || ! -f "$file" ]]; then
    echo "INVALID path: $file" >&2; fail=$((fail+1)); continue
  fi
  if ! printf '%s  %s\n' "$hash" "$file" | sha256sum -c --status; then
    echo "BAD HASH: $name@$version" >&2; fail=$((fail+1)); continue
  fi
  echo "PUBLISH $name@$version"
  if bun publish "./$file" --registry "$REGISTRY" --tolerate-republish --tag imported; then
    ok=$((ok+1))
  else
    echo "FAILED $name@$version" >&2; fail=$((fail+1))
  fi
done < manifest.tsv
echo "Published/already present: $ok; failed: $fail"
if ((fail)); then exit 1; fi
# IMPORTANT: Bun/npm registries may create 'latest' on first publish even with --tag imported.
# Do not claim absence of dist-tags without verifying Gitea's metadata.
echo 'WARNING: Verify/remove dist-tags (including latest) in Gitea; exact-version publishing does not prevent their creation.' >&2
