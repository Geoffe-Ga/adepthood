#!/usr/bin/env node
// Tests for the high+ audit gate. Run: node --test scripts/frontend/
//
// This gate decides whether real vulnerabilities block a merge, so the cases
// that matter most are the ones where it must NOT say "clean": an expired
// allowlist entry, an advisory nobody allowlisted, and — the subtle one — an
// npm audit that failed for a reason unrelated to vulnerabilities.

import assert from "node:assert/strict";
import { test } from "node:test";

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
