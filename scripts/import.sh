#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
: "${GITEA_TOKEN:?Set GITEA_TOKEN}"
registry="${GITEA_REGISTRY:-https://registry.tsniimash.ru:3001/api/packages/js/npm/}"
export GITEA_TOKEN
# Temporary npm-compatible auth config consumed by Bun; no npm executable needed.
conf="$(mktemp)"
trap 'rm -f "$conf"' EXIT
endpoint="${registry#https://}"
endpoint="${endpoint#http://}"
printf '//%s:_authToken=${GITEA_TOKEN}\n' "$endpoint" > "$conf"
export NPM_CONFIG_USERCONFIG="$conf"
count=0
failed=0
while IFS=$'\t' read -r file name version sha; do
  [[ "$file" == file ]] && continue
  [[ -n "$file" ]] || continue
  if [[ ! -f "tgz/$file" ]]; then echo "MISSING $file" >&2; failed=$((failed+1)); continue; fi
  if ! printf '%s  %s\n' "$sha" "tgz/$file" | sha256sum -c --status; then echo "BAD HASH $file" >&2; failed=$((failed+1)); continue; fi
  echo "Publishing $name@$version"
  if bun publish "tgz/$file" --registry "$registry" --tolerate-republish; then
    count=$((count+1))
  else
    echo "FAILED $name@$version" >&2
    failed=$((failed+1))
  fi
done < manifest.tsv
printf 'Published/skipped: %s; failed: %s\n' "$count" "$failed"
((failed == 0))
