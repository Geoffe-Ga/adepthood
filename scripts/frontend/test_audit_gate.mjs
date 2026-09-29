#!/usr/bin/env node
// Tests for the high+ audit gate. Run: node --test scripts/frontend/
//
// This gate decides whether real vulnerabilities block a merge, so the cases
// that matter most are the ones where it must NOT say "clean": an expired
// allowlist entry, an advisory nobody allowlisted, and — the subtle one — an
// npm audit that failed for a reason unrelated to vulnerabilities.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { advisoryReport, evaluate, EXIT } from "./audit-gate.mjs";

const GHSA_ALLOWED = "GHSA-mh99-v99m-4gvg";
const GHSA_OTHER = "GHSA-6g55-p6wh-862q";
const TODAY = "2026-07-24";

/** Minimal shape of `npm audit --json`: the advisory lives under `via`. */
function reportWith(...advisories) {
  const vulnerabilities = {};
  for (const { pkg, id, severity, title } of advisories) {
    vulnerabilities[pkg] = {
      via: [{ url: `https://github.com/advisories/${id}`, severity, title: title ?? id }],
    };
  }
  return { vulnerabilities };
}

const allowlist = [
  { id: GHSA_ALLOWED, package: "brace-expansion", expires: "2026-10-22", issue: 1975 },
];

test("an allowlisted advisory is suppressed and the gate passes", () => {
  const result = evaluate({
    report: reportWith({ pkg: "brace-expansion", id: GHSA_ALLOWED, severity: "high" }),
    allowlist,
    today: TODAY,
  });

  assert.equal(result.exitCode, EXIT.CLEAN);
  assert.deepEqual(
    result.suppressed.map(([id]) => id),
    [GHSA_ALLOWED],
  );
  assert.equal(result.unallowed.length, 0);
});

test("an advisory nobody allowlisted fails the gate", () => {
  const result = evaluate({
    report: reportWith({ pkg: "postcss", id: GHSA_OTHER, severity: "high" }),
    allowlist,
    today: TODAY,
  });

  assert.equal(result.exitCode, EXIT.FAILED);
  assert.deepEqual(
    result.unallowed.map(([id]) => id),
    [GHSA_OTHER],
  );
});

test("critical severity blocks just like high", () => {
  const result = evaluate({
    report: reportWith({ pkg: "postcss", id: GHSA_OTHER, severity: "critical" }),
    allowlist,
    today: TODAY,
  });

  assert.equal(result.exitCode, EXIT.FAILED);
});

test("moderate and low advisories are below the gate", () => {
  const result = evaluate({
    report: reportWith(
      { pkg: "tar", id: "GHSA-r292-9mhp-454m", severity: "moderate" },
      { pkg: "uuid", id: "GHSA-w5hq-g745-h8pq", severity: "low" },
    ),
    allowlist,
    today: TODAY,
  });

  assert.equal(result.exitCode, EXIT.CLEAN);
  assert.equal(result.unallowed.length, 0);
});

test("an expired allowlist entry fails even though the advisory is listed", () => {
  const result = evaluate({
    report: reportWith({ pkg: "brace-expansion", id: GHSA_ALLOWED, severity: "high" }),
    allowlist,
    today: "2026-10-23",
  });

  assert.equal(result.exitCode, EXIT.FAILED);
  assert.deepEqual(
    result.expired.map((entry) => entry.id),
    [GHSA_ALLOWED],
  );
});

test("an entry expiring today is already expired — the boundary does not grant a free day", () => {
  const result = evaluate({
    report: reportWith({ pkg: "brace-expansion", id: GHSA_ALLOWED, severity: "high" }),
    allowlist,
    today: "2026-10-22",
  });

  assert.equal(result.exitCode, EXIT.FAILED);
});

test("an expired entry fails even when its advisory is no longer in the tree", () => {
  const result = evaluate({ report: reportWith(), allowlist, today: "2026-10-23" });

  assert.equal(result.exitCode, EXIT.FAILED);
  assert.equal(result.expired.length, 1);
});

test("a clean tree with a live allowlist entry passes", () => {
  const result = evaluate({ report: reportWith(), allowlist, today: TODAY });

  assert.equal(result.exitCode, EXIT.CLEAN);
});

// The regression that matters most: npm can exit non-zero for reasons that have
// nothing to do with vulnerabilities (registry unreachable, auth failure,
// corrupt lockfile). Its JSON payload then carries an `error` and no
// `vulnerabilities` key. Treating that as "no advisories found" would turn the
// security backstop fail-open, which is strictly worse than the plain
// `npm audit --audit-level=high` this gate replaced.
test("an errored audit payload fails closed rather than reporting clean", () => {
  const result = evaluate({
    report: { error: { code: "ENETUNREACH", summary: "request to registry failed" } },
    allowlist,
    today: TODAY,
  });

  assert.equal(result.exitCode, EXIT.UNAVAILABLE);
});

test("an audit payload missing vulnerabilities entirely fails closed", () => {
  const result = evaluate({ report: {}, allowlist, today: TODAY });

  assert.equal(result.exitCode, EXIT.UNAVAILABLE);
});

test("a non-object payload fails closed", () => {
  const result = evaluate({ report: null, allowlist, today: TODAY });

  assert.equal(result.exitCode, EXIT.UNAVAILABLE);
});

test("advisories are keyed by GHSA id and collect every package they reach", () => {
  const report = {
    vulnerabilities: {
      minimatch: {
        via: [{ url: `https://github.com/advisories/${GHSA_ALLOWED}`, severity: "high", title: "t" }],
      },
      glob: {
        via: [{ url: `https://github.com/advisories/${GHSA_ALLOWED}`, severity: "high", title: "t" }],
      },
    },
  };

  const found = advisoryReport(report);

  assert.deepEqual([...found.keys()], [GHSA_ALLOWED]);
  assert.deepEqual([...found.get(GHSA_ALLOWED).packages].sort(), ["glob", "minimatch"]);
});

test("string `via` entries (transitive pointers, not advisories) are ignored", () => {
  const report = { vulnerabilities: { glob: { via: ["minimatch"] } } };

  assert.equal(advisoryReport(report).size, 0);
});

// ---------------------------------------------------------------------------
// Committed-state invariants (#2159)
//
// image-size (GHSA-w3rx-r6r6-pgpr, GHSA-5p2g-fcmc-qvqq) was allowlisted because
// metro <= 0.84.4 declared it. metro 0.84.5+ dropped the dependency, the
// lockfile moved the metro family forward, and both entries were deleted. These
// tests read the committed files directly -- never through the gate's
// loadAllowlist(), which falls back to [] on a missing or corrupt file -- so the
// edge cannot quietly return and the dead suppressions cannot quietly come back.

const IMAGE_SIZE = "image-size";
const METRO = "metro";
const METRO_SIBLING_PREFIX = "metro-";
const GHSA_IMAGE_SIZE_ICNS = "GHSA-w3rx-r6r6-pgpr";
const GHSA_IMAGE_SIZE_JXL_HEIF = "GHSA-5p2g-fcmc-qvqq";
const IMAGE_SIZE_ADVISORIES = new Set([GHSA_IMAGE_SIZE_ICNS, GHSA_IMAGE_SIZE_JXL_HEIF]);
const IMAGE_SIZE_ISSUE = 2159;
/** metro plus its 13 exact-pinned metro-* siblings, in each resolved copy. */
const METRO_FAMILY_SIZE = 14;
const LOCK_KEY_SEPARATOR = "node_modules/";
const LOCKFILE_PATH = fileURLToPath(new URL("../../frontend/package-lock.json", import.meta.url));
const ALLOWLIST_PATH = fileURLToPath(new URL("../../frontend/.audit-allowlist.json", import.meta.url));

/** Lockfile `packages` keys whose installed package name satisfies `predicate`. */
function lockPackageKeysNamed(lock, predicate) {
  return Object.keys(lock.packages).filter((key) =>
    predicate(key.split(LOCK_KEY_SEPARATOR).pop()),
  );
}

function isMetroFamily(name) {
  return name === METRO || name.startsWith(METRO_SIBLING_PREFIX);
}

/**
 * Throw unless the lock resolves at least one full metro family and no metro
 * or metro-* entry declares image-size. An empty family fails too, so a broken
 * predicate cannot make the check pass vacuously.
 */
function assertMetroFamilyImageSizeFree(lock) {
  const family = lockPackageKeysNamed(lock, isMetroFamily);
  assert.ok(
    family.length >= METRO_FAMILY_SIZE,
    `expected >= ${METRO_FAMILY_SIZE} metro-family lockfile entries, found ${family.length}`,
  );
  const offenders = family
    .filter((key) => lock.packages[key].dependencies?.[IMAGE_SIZE] !== undefined)
    .map((key) => `${key}@${lock.packages[key].version}`);
  assert.deepEqual(
    offenders,
    [],
    `metro-family entries declare ${IMAGE_SIZE} again (see #${IMAGE_SIZE_ISSUE})`,
  );
}

/**
 * Throw unless the allowlist keeps its policy `$comment` and an `allow` array
 * with no entry for either image-size advisory or for #2159.
 */
function assertNoImageSizeSuppression(allowlist) {
  assert.ok(
    Array.isArray(allowlist.$comment) && allowlist.$comment.length > 0,
    "frontend/.audit-allowlist.json lost its policy $comment",
  );
  assert.ok(Array.isArray(allowlist.allow), "frontend/.audit-allowlist.json has no allow array");
  const stale = allowlist.allow.filter(
    (entry) => IMAGE_SIZE_ADVISORIES.has(entry.id) || entry.issue === IMAGE_SIZE_ISSUE,
  );
  assert.deepEqual(stale, [], `dead ${IMAGE_SIZE} suppressions are back; see #${IMAGE_SIZE_ISSUE}`);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** A synthetic lock with one full metro family at `version`, deps per entry. */
function metroFamilyLock(dependencies) {
  const siblings = [
    "babel-transformer", "cache", "cache-key", "config", "core", "file-map",
    "minify-terser", "resolver", "runtime", "source-map", "symbolicate",
    "transform-plugins", "transform-worker",
  ];
  const packages = { "": {}, [`node_modules/${METRO}`]: { version: "0.84.6", dependencies } };
  for (const sibling of siblings) {
    packages[`node_modules/${METRO_SIBLING_PREFIX}${sibling}`] = { version: "0.84.6" };
  }
  packages["node_modules/@expo/metro"] = { version: "56.0.2" };
  packages["node_modules/metronome"] = { version: "1.0.0", dependencies: { [IMAGE_SIZE]: "^1.0.2" } };
  return { packages };
}

test("lockPackageKeysNamed matches the installed name exactly, nested or hoisted", () => {
  const lock = {
    packages: {
      "": {},
      [`node_modules/${IMAGE_SIZE}`]: {},
      [`node_modules/${METRO}/node_modules/${IMAGE_SIZE}`]: {},
      [`node_modules/${IMAGE_SIZE}-extra`]: {},
      [`node_modules/@x/${IMAGE_SIZE}`]: {},
    },
  };

  assert.deepEqual(lockPackageKeysNamed(lock, (name) => name === IMAGE_SIZE), [
    `node_modules/${IMAGE_SIZE}`,
    `node_modules/${METRO}/node_modules/${IMAGE_SIZE}`,
  ]);
});

test("the metro-family check passes a clean family and ignores look-alike names", () => {
  assert.doesNotThrow(() => assertMetroFamilyImageSizeFree(metroFamilyLock({})));
});

test("the metro-family check names a metro entry that still declares image-size", () => {
  const lock = metroFamilyLock({ [IMAGE_SIZE]: "^1.0.2" });

  assert.throws(() => assertMetroFamilyImageSizeFree(lock), /node_modules\/metro@0\.84\.6/);
});

test("the metro-family check fails rather than passing vacuously on no metro", () => {
  assert.throws(() => assertMetroFamilyImageSizeFree({ packages: { "": {} } }), /found 0/);
});

const POLICY_COMMENT = ["policy"];
const UNRELATED_ENTRY = { id: GHSA_OTHER, package: "brace-expansion", issue: 1975 };

test("the allowlist check accepts an unrelated owner-approved entry", () => {
  assert.doesNotThrow(() =>
    assertNoImageSizeSuppression({ $comment: POLICY_COMMENT, allow: [UNRELATED_ENTRY] }),
  );
});

test("the allowlist check rejects either image-size GHSA, whatever issue it cites", () => {
  for (const id of [GHSA_IMAGE_SIZE_ICNS, GHSA_IMAGE_SIZE_JXL_HEIF]) {
    const allowlist = { $comment: POLICY_COMMENT, allow: [{ id, issue: 1 }] };

    assert.throws(() => assertNoImageSizeSuppression(allowlist), /dead image-size suppressions/);
  }
});

test("the allowlist check rejects any entry still tracked by #2159", () => {
  const allowlist = { $comment: POLICY_COMMENT, allow: [{ id: GHSA_OTHER, issue: IMAGE_SIZE_ISSUE }] };

  assert.throws(() => assertNoImageSizeSuppression(allowlist), /dead image-size suppressions/);
});

test("the allowlist check rejects a file that lost its policy $comment", () => {
  assert.throws(() => assertNoImageSizeSuppression({ allow: [] }), /lost its policy \$comment/);
});

test("the committed lockfile resolves no image-size (#2159)", () => {
  const lock = readJson(LOCKFILE_PATH);

  assert.deepEqual(
    lockPackageKeysNamed(lock, (name) => name === IMAGE_SIZE),
    [],
    `${IMAGE_SIZE} is back in frontend/package-lock.json; see #${IMAGE_SIZE_ISSUE}`,
  );
});

test("no committed metro-family entry declares image-size (#2159)", () => {
  assertMetroFamilyImageSizeFree(readJson(LOCKFILE_PATH));
});

test("the committed allowlist keeps its $comment and holds no image-size entry (#2159)", () => {
  assertNoImageSizeSuppression(readJson(ALLOWLIST_PATH));
});
