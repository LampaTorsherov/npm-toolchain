#!/usr/bin/env bash
set -uo pipefail

ROOT="$(pwd -P)"
REGISTRY="${REGISTRY:-https://registry.tsniimash.ru:3001/api/packages/js/npm/}"
MANIFEST="$ROOT/manifest.tsv"
TMP="$ROOT/pkg-tmp"

: "${GITEA_TOKEN:?Set GITEA_TOKEN first}"
[[ -f "$MANIFEST" ]] || { echo "Missing $MANIFEST" >&2; exit 1; }
[[ ! -e "$TMP" ]] || { echo "Refusing to overwrite existing $TMP" >&2; exit 1; }

export NPM_CONFIG_TOKEN="$GITEA_TOKEN"
trap 'rm -rf -- "$TMP"' EXIT

ok=0
failed=0

while IFS=$'\t' read -r name version file sha256 integrity; do
  [[ "$name" == "name" || -z "$name" ]] && continue
  echo "PUBLISH $name@$version"

  archive="$ROOT/$file"
  if [[ ! -f "$archive" ]] || ! echo "$sha256  $archive" | sha256sum -c --status; then
    echo "FAILED: missing archive or SHA-256 mismatch: $name@$version" >&2
    ((failed+=1))
    continue
  fi

  mkdir -p -- "$TMP"
  if ! tar -xzf "$archive" -C "$TMP" --no-same-owner --no-same-permissions \
      || [[ ! -f "$TMP/package/package.json" ]]; then
    echo "FAILED: invalid package archive: $name@$version" >&2
    ((failed+=1))
    rm -rf -- "$TMP"
    continue
  fi

  if (cd "$TMP/package" && bun publish \
      --registry "$REGISTRY" \
      --tag imported \
      --tolerate-republish \
      --ignore-scripts); then
    ((ok+=1))
  else
    echo "FAILED: $name@$version" >&2
    ((failed+=1))
  fi

  rm -rf -- "$TMP"
done < "$MANIFEST"

echo "Published: $ok; Failed: $failed"
(( failed == 0 ))
