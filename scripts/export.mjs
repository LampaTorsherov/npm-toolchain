#!/usr/bin/env bun

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  copyFileSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import semver from "semver";

const ROOT = resolve(import.meta.dir, "..");
const OUT = join(ROOT, "dist");
const STAGE = join(OUT, "transfer");

const REGISTRY = (
  process.env.NPM_REGISTRY || "https://registry.npmjs.org"
).replace(/\/$/, "");

const ALL_DEV = process.env.INCLUDE_TRANSITIVE_DEV_DEPS === "true";
const MAX = Number(process.env.MAX_PACKAGES || 15000);
const WORKERS = 12;
const DOWNLOAD_WORKERS = 8;

if (!Number.isSafeInteger(MAX) || MAX < 1) {
  throw new Error("Invalid MAX_PACKAGES");
}

const metadataCache = new Map();
const selected = new Map();
const queue = [];
const warnings = [];

let cursor = 0;
let firstError = null;

const exact = (v) => semver.valid(v) === v;
const stable = (v) => exact(v) && semver.prerelease(v) === null;
const key = (name, version) => `${name}@${version}`;

function pkgUrl(name) {
  return `${REGISTRY}/${encodeURIComponent(name)}`;
}

async function getJSON(url) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(url, {
      headers: { Accept: "application/json" },
    });

    if (r.ok) return r.json();

    if (
      ![429, 500, 502, 503, 504].includes(r.status) ||
      attempt === 3
    ) {
      throw new Error(`HTTP ${r.status}: ${url}`);
    }

    await Bun.sleep(500 * (2 ** attempt));
  }
}

function metadata(name) {
  if (!metadataCache.has(name)) {
    metadataCache.set(name, getJSON(pkgUrl(name)));
  }

  return metadataCache.get(name);
}

function chooseVersion(meta, range, context) {
  const versions = Object.keys(meta.versions || {}).filter(exact);

  // Exact prereleases are allowed for transitive dependencies.
  if (exact(range)) {
    if (!meta.versions[range]) {
      throw new Error(`${context}: missing exact version ${range}`);
    }

    return range;
  }

  const resolved = semver.maxSatisfying(versions, range, {
    includePrerelease: false,
  });

  if (!resolved) {
    throw new Error(
      `${context}: no published version satisfies ${range}`
    );
  }

  return resolved;
}

function parseSpec(name, range) {
  // npm alias:
  // alias-name -> npm:real-name@^1.2.0
  if (range.startsWith("npm:")) {
    const body = range.slice(4);
    const at = body.lastIndexOf("@");

    if (at <= 0) {
      throw new Error(`Bad npm alias: ${name}@${range}`);
    }

    return [body.slice(0, at), body.slice(at + 1)];
  }

  return [name, range];
}

function enqueue(name, version, info) {
  const id = key(name, version);

  if (selected.has(id)) return;

  if (selected.size >= MAX) {
    throw new Error(
      `MAX_PACKAGES=${MAX} exceeded; refusing incomplete archive`
    );
  }

  selected.set(id, { name, version, info });
  queue.push(id);
}

// --------------------------------------------------
// 1. Resolve root package versions
// --------------------------------------------------

async function selectRoots() {
  const lines = readFileSync(
    join(ROOT, "packages.txt"),
    "utf8"
  ).split(/\r?\n/);

  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();

    if (!line || line.startsWith("#")) continue;

    const parts = line.split("|").map((x) => x.trim());

    if (parts.length !== 3) {
      throw new Error(
        `packages.txt:${index + 1}: expected name|selector|arg`
      );
    }

    const [name, selector, arg] = parts;
    const meta = await metadata(name);

    const versions = Object.keys(meta.versions || {})
      .filter(stable)
      .sort(semver.compare);

    let chosen;

    if (selector === "exact") {
      if (!meta.versions?.[arg] || !stable(arg)) {
        throw new Error(
          `${name}@${arg}: missing or not stable`
        );
      }

      chosen = [arg];
    } else if (selector === "latest") {
      if (!versions.length) {
        throw new Error(`${name}: no stable versions`);
      }

      chosen = [versions.at(-1)];
    } else if (selector === "major") {
      chosen = arg
        .split(",")
        .map((s) => s.trim())
        .map((major) => {
          const found = versions
            .filter(
              (v) => String(semver.major(v)) === major
            )
            .at(-1);

          if (!found) {
            console.warn(
              `WARN: ${name} has no stable major ${major}`
            );
          }

          return found;
        })
        .filter(Boolean);

      if (!chosen.length) {
        throw new Error(`${name}: no matching majors`);
      }
    } else if (selector === "yearly") {
      const match =
        /^(\d{4}-\d\d-\d\d)\.\.(\d{4}-\d\d-\d\d)$/.exec(arg);

      if (!match) {
        throw new Error(
          `${name}: invalid yearly range ${arg}`
        );
      }

      const byMinor = new Map();

      for (const v of versions) {
        const day = meta.time?.[v]?.slice(0, 10);

        if (
          !day ||
          day < match[1] ||
          day > match[2]
        ) {
          continue;
        }

        const minor =
          `${semver.major(v)}.${semver.minor(v)}`;

        byMinor.set(minor, v);
      }

      chosen = [...byMinor.values()];

      if (!chosen.length) {
        throw new Error(
          `${name}: no stable versions in ${arg}`
        );
      }
    } else {
      throw new Error(`Unknown selector: ${selector}`);
    }

    for (const v of chosen) {
      enqueue(name, v, { root: true });
    }
  }

  console.log(
    `Root versions: ${selected.size}; ` +
    `transitive devDeps: ${ALL_DEV}`
  );
}

// --------------------------------------------------
// 2. Resolve full dependency closure
// --------------------------------------------------

async function resolveOne(id) {
  const item = selected.get(id);
  const meta = await metadata(item.name);
  const record = meta.versions?.[item.version];

  if (!record) {
    throw new Error(`${id}: version metadata missing`);
  }

  const groups = [
    ["dependencies", record.dependencies || {}],
    ["optionalDependencies", record.optionalDependencies || {}],
    ["peerDependencies", record.peerDependencies || {}],
  ];

  if (item.info.root || ALL_DEV) {
    groups.push([
      "devDependencies",
      record.devDependencies || {},
    ]);
  }

  for (const [kind, deps] of groups) {
    for (const [alias, rawRange] of Object.entries(deps)) {
      const optionalPeer =
        kind === "peerDependencies" &&
        record.peerDependenciesMeta?.[alias]?.optional === true;

      const optional =
        kind === "optionalDependencies" || optionalPeer;

      try {
        if (typeof rawRange !== "string") {
          throw new Error(
            `invalid range ${String(rawRange)}`
          );
        }

        const [name, range] = parseSpec(
          alias,
          rawRange
        );

        if (!semver.validRange(range)) {
          throw new Error(
            `non-semver / non-registry spec ${range}`
          );
        }

        const childMeta = await metadata(name);

        const version = chooseVersion(
          childMeta,
          range,
          `${id} -> ${alias}`
        );

        enqueue(name, version, { root: false });
      } catch (e) {
        const msg =
          `${id} ${kind} ${alias}@${rawRange}: ${e.message}`;

        if (!optional) {
          throw new Error(msg);
        }

        warnings.push(`OPTIONAL SKIPPED: ${msg}`);
      }
    }
  }
}

async function resolveAll() {
  const jobs = Array.from(
    { length: WORKERS },
    async () => {
      while (
        !firstError &&
        cursor < queue.length
      ) {
        const id = queue[cursor++];

        try {
          await resolveOne(id);
        } catch (e) {
          firstError ||= e;
        }

        if (cursor % 250 === 0) {
          console.log(
            `Resolved ${cursor}/${queue.length} ` +
            `(${selected.size} unique)`
          );
        }
      }
    }
  );

  await Promise.all(jobs);

  if (firstError) {
    throw firstError;
  }

  console.log(
    `Dependency closure: ${selected.size} ` +
    `unique name@version entries`
  );
}

// --------------------------------------------------
// 3. Download and verify original npm tarballs
// --------------------------------------------------

async function downloadOne(item, index) {
  const meta = await metadata(item.name);
  const dist = meta.versions?.[item.version]?.dist;

  if (!dist?.tarball) {
    throw new Error(
      `${key(item.name, item.version)}: missing tarball URL`
    );
  }

  const url = new URL(dist.tarball);

  if (
    url.protocol !== "https:" ||
    url.hostname !== "registry.npmjs.org"
  ) {
    throw new Error(
      `${key(item.name, item.version)}: ` +
      `unexpected tarball host ${url.hostname}`
    );
  }

  const r = await fetch(url);

  if (!r.ok) {
    throw new Error(
      `${key(item.name, item.version)} tarball: HTTP ${r.status}`
    );
  }

  const bytes = Buffer.from(await r.arrayBuffer());

  const tokens = (dist.integrity || "").split(/\s+/);

  const sri =
    tokens.find((x) => x.startsWith("sha512-")) ||
    tokens.find((x) => x.startsWith("sha1-"));

  if (sri) {
    const dash = sri.indexOf("-");
    const algo = sri.slice(0, dash);
    const expected = sri.slice(dash + 1).split("?")[0];

    if (
      createHash(algo)
        .update(bytes)
        .digest("base64") !== expected
    ) {
      throw new Error(
        `${key(item.name, item.version)}: SRI mismatch`
      );
    }
  } else if (dist.shasum) {
    if (
      createHash("sha1")
        .update(bytes)
        .digest("hex") !== dist.shasum
    ) {
      throw new Error(
        `${key(item.name, item.version)}: SHA1 mismatch`
      );
    }
  } else {
    throw new Error(
      `${key(item.name, item.version)}: ` +
      `missing integrity information`
    );
  }

  const sha256 = createHash("sha256")
    .update(bytes)
    .digest("hex");

  const file =
    `tgz/${String(index).padStart(6, "0")}.tgz`;

  writeFileSync(
    join(STAGE, file),
    bytes
  );

  const integrity =
    dist.integrity ||
    `sha1-${Buffer.from(
      dist.shasum,
      "hex"
    ).toString("base64")}`;

  return [
    item.name,
    item.version,
    file,
    sha256,
    integrity,
  ].join("\t");
}

async function downloadAll() {
  const items = [...selected.values()].sort(
    (a, b) =>
      a.name.localeCompare(b.name) ||
      semver.compare(a.version, b.version)
  );

  const lines = new Array(items.length);

  let next = 0;
  let failure = null;

  await Promise.all(
    Array.from(
      { length: DOWNLOAD_WORKERS },
      async () => {
        while (
          !failure &&
          next < items.length
        ) {
          const i = next++;

          try {
            lines[i] = await downloadOne(
              items[i],
              i
            );
          } catch (e) {
            failure ||= e;
          }

          if (next % 100 === 0) {
            console.log(
              `Downloaded ${next}/${items.length}`
            );
          }
        }
      }
    )
  );

  if (failure) {
    throw failure;
  }

  writeFileSync(
    join(STAGE, "manifest.tsv"),
    "name\tversion\tfile\tsha256\tsha512\n" +
      lines.join("\n") +
      "\n"
  );
}

// --------------------------------------------------
// 4. Build airgap transfer archive
// --------------------------------------------------

async function main() {
  rmSync(OUT, {
    recursive: true,
    force: true,
  });

  mkdirSync(
    join(STAGE, "tgz"),
    { recursive: true }
  );

  await selectRoots();
  await resolveAll();
  await downloadAll();

  writeFileSync(
    join(STAGE, "warnings.txt"),
    warnings.join("\n") +
      (warnings.length ? "\n" : "")
  );

  if (warnings.length) {
    console.warn(
      `Optional dependencies skipped: ${warnings.length} ` +
      `(see warnings.txt)`
    );
  }

  copyFileSync(
    join(ROOT, "scripts", "import.sh"),
    join(STAGE, "import.sh")
  );

  const archive = join(
    OUT,
    "bun-registry-export.tar.gz"
  );

  const proc = Bun.spawn(
    [
      "tar",
      "-czf",
      archive,
      "-C",
      STAGE,
      ".",
    ],
    {
      stdout: "inherit",
      stderr: "inherit",
    }
  );

  if ((await proc.exited) !== 0) {
    throw new Error("tar failed");
  }

  console.log(`DONE: ${archive}`);
}

await main();
