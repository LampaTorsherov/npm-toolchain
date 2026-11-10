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

for tool in npm python3 tar; do
    command -v "$tool" >/dev/null 2>&1 || {
        echo "ERROR: $tool not found" >&2
        exit 1
    }
done

[[ ! -e "$TMP" ]] || {
    echo "ERROR: $TMP already exists; refusing to delete" >&2
    exit 1
}

NPM_OPTS=(
    --registry="$REGISTRY"
    --fetch-retries=0
    --fetch-timeout=10000
)

total=$(awk 'NR > 1 && NF { n++ } END { print n+0 }' "$MANIFEST")

(( START <= total )) || {
    echo "ERROR: START=$START exceeds total=$total" >&2
    exit 2
}

cleanup() {
    rm -rf -- "$TMP"
}

trap cleanup EXIT

publish() {
    local archive="$1" log="$2"

    npm publish "$archive" "${NPM_OPTS[@]}" \
        --tag=imported \
        --ignore-scripts \
        --provenance=false \
        --loglevel=error >"$log" 2>&1
}

normalize_metadata() {
    local original="$1" destination="$2"

    mkdir -p "$TMP/unpacked"

    tar -xzf "$original" -C "$TMP/unpacked"

    python3 - "$TMP/unpacked/package/package.json" <<'PYTHON'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
pkg = json.loads(path.read_text(encoding="utf-8"))
changes = []

# Gitea expects libc to be an array.
libc = pkg.get("libc")

if isinstance(libc, str):
    pkg["libc"] = [libc]
    changes.append(f"libc: {libc!r} -> {[libc]!r}")

# Gitea expects engines to be an object.
engines = pkg.get("engines")

if isinstance(engines, list):
    normalized = {}

    for entry in engines:
        if not isinstance(entry, str):
            raise SystemExit(
                f"ERROR: unsupported engines entry: {entry!r}"
            )

        parts = entry.strip().split(None, 1)

        if len(parts) != 2 or not parts[0] or not parts[1]:
            raise SystemExit(
                f"ERROR: invalid engines entry: {entry!r}"
            )

        if parts[0] in normalized:
            raise SystemExit(
                f"ERROR: duplicate engines key: {parts[0]}"
            )

        normalized[parts[0]] = parts[1]

    pkg["engines"] = normalized
    changes.append(
        f"engines: {engines!r} -> {normalized!r}"
    )

if not changes:
    raise SystemExit(
        "ERROR: neither string libc nor array engines found"
    )

path.write_text(
    json.dumps(pkg, ensure_ascii=False, indent=2) + "\n",
    encoding="utf-8"
)

for change in changes:
    print(f"NORMALIZED: {change}")
PYTHON

    tar -czf "$destination" -C "$TMP/unpacked" package
}

count=0
published=0
skipped=0
normalized=0

while IFS=$'\t' read -r name version file sha256 integrity || [[ -n "$name" ]]; do
    [[ -n "$name" && "$name" != "name" ]] || continue

    count=$((count + 1))

    (( count >= START )) || continue

    archive="$ROOT/$file"

    [[ -f "$archive" ]] || {
        echo "ERROR: missing $archive" >&2
        exit 1
    }

    echo "[$count/$total] $name@$version"

    existing=$(npm view "$name@$version" version \
        "${NPM_OPTS[@]}" \
        --json \
        --loglevel=silent 2>/dev/null) || existing=""

    if [[ "$existing" == "\\"$version\\"" ]]; then
        echo "SKIP: already published $name@$version"
        skipped=$((skipped + 1))
        continue
    fi

    mkdir -p "$TMP"

    if publish "$archive" "$TMP/publish.log"; then
        published=$((published + 1))
        echo "OK: $name@$version"
        rm -rf -- "$TMP"
        continue
    fi

    cat "$TMP/publish.log" >&2

    if ! grep -Eq 'E500|500 Internal Server Error' "$TMP/publish.log"; then
        echo "ERROR: publication failed (not HTTP 500); stopping" >&2
        exit 1
    fi

    echo "HTTP 500: checking whether metadata normalization applies..."

    if ! normalize_metadata "$archive" "$TMP/normalized.tgz"; then
        echo "ERROR: cannot normalize $name@$version; stopping" >&2
        exit 1
    fi

    if ! publish "$TMP/normalized.tgz" "$TMP/retry.log"; then
        cat "$TMP/retry.log" >&2
        echo "ERROR: normalized publication failed; stopping" >&2
        exit 1
    fi

    published=$((published + 1))
    normalized=$((normalized + 1))

    echo "OK (normalized metadata): $name@$version"

    rm -rf -- "$TMP"

done < "$MANIFEST"

echo "DONE: start=$START processed=$((count - START + 1)) published=$published skipped=$skipped normalized=$normalized"
