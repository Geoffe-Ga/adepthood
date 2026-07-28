#!/usr/bin/env node
// High+ npm audit gate with a per-advisory allowlist.
//
// `npm audit --audit-level=high` is all-or-nothing: one unfixable transitive
// advisory turns the whole gate off for everyone. This keeps the gate on and
// narrows the exception to specific GHSA ids, each of which must carry an
// expiry date that this script enforces — an expired entry fails the build
// exactly like an unallowlisted advisory, so a suppression cannot quietly
// become permanent.
//
// Fails CLOSED. `npm audit` exits non-zero both when it finds advisories and
// when it could not run at all (registry unreachable, auth failure, corrupt
// lockfile), and the latter yields a payload with an `error` and no
// `vulnerabilities`. Reading that as "no advisories" would make the security
// backstop pass precisely when it learned nothing, so an unusable payload
// exits UNAVAILABLE rather than CLEAN.
//
// Logic is exported for scripts/frontend/test_audit_gate.mjs; running the file
// directly performs the check.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { argv } from "node:process";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = join(HERE, "..", "..", "frontend");
const ALLOWLIST_PATH = join(FRONTEND_DIR, ".audit-allowlist.json");
const BLOCKING_SEVERITIES = new Set(["high", "critical"]);

export const EXIT = { CLEAN: 0, FAILED: 1, UNAVAILABLE: 2 };

/**
 * Collect every GHSA id at high or critical severity, with the packages it
 * reaches. npm nests the real advisory under each vulnerability's `via`;
 * string entries there are pointers to other packages, not advisories.
 */
export function advisoryReport(report) {
  const found = new Map();
  for (const [name, vuln] of Object.entries(report?.vulnerabilities ?? {})) {
    for (const via of vuln?.via ?? []) {
      if (typeof via !== "object" || via === null) continue;
      if (!BLOCKING_SEVERITIES.has(via.severity)) continue;
      const id = via.url?.split("/").pop() ?? via.source?.toString() ?? via.title;
      if (!found.has(id)) found.set(id, { title: via.title, packages: new Set() });
      found.get(id).packages.add(name);
    }
  }
  return found;
}

/** True when the payload cannot be trusted to describe the dependency tree. */
function isUnusable(report) {
  if (typeof report !== "object" || report === null) return true;
  if (report.error) return true;
  // A genuinely clean tree still reports `vulnerabilities: {}`; a missing key
  // means npm did not get far enough to tell us anything.
  return typeof report.vulnerabilities !== "object" || report.vulnerabilities === null;
}

/**
 * Decide the gate outcome. Pure — takes the audit payload, the allowlist, and
 * today's date, and returns what failed and why.
 */
export function evaluate({ report, allowlist, today }) {
  if (isUnusable(report)) {
    return { exitCode: EXIT.UNAVAILABLE, expired: [], unallowed: [], suppressed: [] };
  }

  const expired = allowlist.filter((entry) => entry.expires <= today);
  const active = new Set(
    allowlist.filter((entry) => entry.expires > today).map((entry) => entry.id),
  );

  const advisories = [...advisoryReport(report)];
  const unallowed = advisories.filter(([id]) => !active.has(id));
  const suppressed = advisories.filter(([id]) => active.has(id));
  const exitCode = expired.length > 0 || unallowed.length > 0 ? EXIT.FAILED : EXIT.CLEAN;

  return { exitCode, expired, unallowed, suppressed };
}

/** Run `npm audit --json`, which exits non-zero whenever findings exist. */
function runAudit() {
  try {
    return JSON.parse(
      execFileSync("npm", ["audit", "--json"], {
        cwd: FRONTEND_DIR,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      }),
    );
  } catch (error) {
    if (typeof error.stdout === "string" && error.stdout.trim()) {
      try {
        return JSON.parse(error.stdout);
      } catch {
        return null; // Unparseable output — isUnusable() turns this into EXIT.UNAVAILABLE.
      }
    }
    console.error(`audit-gate: could not run npm audit — ${error.message}`);
    return null;
  }
}

function loadAllowlist() {
  try {
    return JSON.parse(readFileSync(ALLOWLIST_PATH, "utf8")).allow ?? [];
  } catch {
    return [];
  }
}

function main() {
  const report = runAudit();
  const allowlist = loadAllowlist();
  const today = new Date().toISOString().slice(0, 10);
  const { exitCode, expired, unallowed, suppressed } = evaluate({ report, allowlist, today });

  if (exitCode === EXIT.UNAVAILABLE) {
    console.error(
      "audit-gate: npm audit did not return a usable report (registry, auth, or lockfile\n" +
        "  problem — not a clean tree). Failing closed: a gate that passes when it learned\n" +
        "  nothing is worse than no gate at all.",
    );
    return EXIT.UNAVAILABLE;
  }

  for (const entry of expired) {
    console.error(
      `audit-gate: allowlist entry ${entry.id} (${entry.package}) EXPIRED on ${entry.expires}.\n` +
        `  The time box is up. Re-evaluate the advisory — see issue #${entry.issue}.\n` +
        `  Extending a suppression is a policy decision, not an engineering one: ask the owner.`,
    );
  }

  for (const [id, { title, packages }] of unallowed) {
    console.error(`audit-gate: ${id} — ${title}\n  reaches: ${[...packages].sort().join(", ")}`);
  }

  for (const [id] of suppressed) {
    const entry = allowlist.find((candidate) => candidate.id === id);
    console.warn(`audit-gate: allowing ${id} until ${entry.expires} (tracked in #${entry.issue})`);
  }

  if (exitCode === EXIT.FAILED) {
    console.error(
      `\naudit-gate: FAILED — ${unallowed.length} unallowed high/critical advisor${
        unallowed.length === 1 ? "y" : "ies"
      }, ${expired.length} expired allowlist entr${expired.length === 1 ? "y" : "ies"}.`,
    );
    return EXIT.FAILED;
  }

  console.log(
    `audit-gate: clean — no unallowed high/critical advisories (${suppressed.length} allowlisted).`,
  );
  return EXIT.CLEAN;
}

if (argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
