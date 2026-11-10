#!/usr/bin/env bash
set -Eeuo pipefail

REGISTRY="${REGISTRY:-https://registry.tsniimash.ru:3001/api/packages/js/npm/}"
ROOT="$(pwd -P)"
MANIFEST="$ROOT/manifest.tsv"
TMP="$ROOT/pkg-tmp"
START="${1:-1}"

if (( $# > 1 )) || [[ ! "$START" =~ ^[1-9][0-9]*$ ]]; then
    echo "Usage: $0 [START_PACKAGE_NUMBER (1-based)]" >&2
    exit 2
fi

[[ -f "$MANIFEST" ]] || {
    echo "ERROR: missing $MANIFEST" >&2
    exit 1
}

command -v bun >/dev/null 2>&1 || {
    echo "ERROR: bun not found" >&2
    exit 1
}

[[ ! -e "$TMP" ]] || {
    echo "ERROR: $TMP already exists; refusing to delete" >&2
    exit 1
}

total=$(awk 'NR > 1 && NF { n++ } END { print n+0 }' "$MANIFEST")

if (( START > total )); then
    echo "ERROR: START=$START exceeds total=$total" >&2
    exit 2
fi

cleanup() {
    cd "$ROOT" || true
    rm -rf -- "$TMP"
}

trap cleanup EXIT

count=0
published=0

while IFS=$'\t' read -r name version file sha256 integrity || [[ -n "$name" ]]; do
    [[ -n "$name" && "$name" != "name" ]] || continue

    count=$((count + 1))
    (( count >= START )) || continue

    archive="$ROOT/$file"

    [[ -f "$archive" ]] || {
        echo "ERROR: missing $archive" >&2
        exit 1
    }

    echo "[$count/$total] Publishing $name@$version"

    mkdir -p "$TMP/package"

    cp -- "$archive" "$TMP/package.tgz"

    # Extract only package.json from the archive.
    tar -xzf "$TMP/package.tgz" \
        -C "$TMP" \
        package/package.json

    mv -- "$TMP/package/package.json" "$TMP/package.json"
    rmdir -- "$TMP/package"

    # Bun requires package.json in the current directory.
    cd "$TMP"

    bun publish ./package.tgz \
        --registry "$REGISTRY" \
        --tag imported \
        --tolerate-republish \
        --ignore-scripts \
        --no-provenance

    cd "$ROOT"

    rm -rf -- "$TMP"

    published=$((published + 1))
    echo "OK: $name@$version"

done < "$MANIFEST"

echo "DONE: start=$START processed=$((count - START + 1)) successful=$published"
