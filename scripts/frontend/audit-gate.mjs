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
// Exit codes: 0 clean, 1 gate failed, 2 could not run the audit.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FRONTEND_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "frontend");
const ALLOWLIST_PATH = join(FRONTEND_DIR, ".audit-allowlist.json");
const BLOCKING_SEVERITIES = new Set(["high", "critical"]);

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
      return JSON.parse(error.stdout);
    }
    console.error(`audit-gate: could not run npm audit — ${error.message}`);
    process.exit(2);
  }
}

function loadAllowlist() {
  try {
    const parsed = JSON.parse(readFileSync(ALLOWLIST_PATH, "utf8"));
    return parsed.allow ?? [];
  } catch {
    return [];
  }
}

/**
 * Collect every GHSA id at high or critical severity, with the packages it
 * reaches. npm nests the real advisory under each vulnerability's `via`.
 */
function blockingAdvisories(report) {
  const found = new Map();
  for (const [name, vuln] of Object.entries(report.vulnerabilities ?? {})) {
    for (const via of vuln.via ?? []) {
      if (typeof via !== "object" || !BLOCKING_SEVERITIES.has(via.severity)) continue;
      const id = via.url?.split("/").pop() ?? via.source?.toString() ?? via.title;
      if (!found.has(id)) found.set(id, { title: via.title, packages: new Set() });
      found.get(id).packages.add(name);
    }
  }
  return found;
}

const today = new Date().toISOString().slice(0, 10);
const allowlist = loadAllowlist();
const expired = allowlist.filter((entry) => entry.expires <= today);
const active = new Set(
  allowlist.filter((entry) => entry.expires > today).map((entry) => entry.id),
);

const advisories = blockingAdvisories(runAudit());
const unallowed = [...advisories].filter(([id]) => !active.has(id));

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

const suppressed = [...advisories].filter(([id]) => active.has(id));
for (const [id] of suppressed) {
  const entry = allowlist.find((candidate) => candidate.id === id);
  console.warn(`audit-gate: allowing ${id} until ${entry.expires} (tracked in #${entry.issue})`);
}

if (expired.length > 0 || unallowed.length > 0) {
  console.error(
    `\naudit-gate: FAILED — ${unallowed.length} unallowed high/critical advisor${
      unallowed.length === 1 ? "y" : "ies"
    }, ${expired.length} expired allowlist entr${expired.length === 1 ? "y" : "ies"}.`,
  );
  process.exit(1);
}

console.log(
  `audit-gate: clean — no unallowed high/critical advisories (${suppressed.length} allowlisted).`,
);
