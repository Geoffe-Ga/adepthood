#!/usr/bin/env node
// Prove the installed frontend tree was built from the committed lockfile.
//
// Every frontend gate measures *installed* packages. `require-node-modules.sh`
// used to ask only whether they exist, and presence is not freshness: a tree
// installed weeks ago satisfies it, and the staleness then surfaces two stages
// later as an Expo SDK alignment failure whose text sends the reader at the
// committed pins. That cost a full false-bug cycle -- an issue filed reporting
// ten SDK packages behind on `main`, with the gate output as evidence, when the
// manifests had been right all along and only the install was stale.
//
// The oracle is npm's own install receipt, `node_modules/.package-lock.json`,
// which npm writes at install time to record the tree it resolved. Reading it
// needs no tree walk and no network: a complete comparison of all ~1165 entries
// against the committed lockfile measures ~10ms, which is cheaper AND strictly
// more complete than spot-checking a handful of sentinel packages, since a
// sentinel set can miss the one package that drifted.
//
// Three tree shapes exist, not one. `frontend/node_modules` may be absent, a
// real directory, or -- inside a Ralph fleet lane -- a symlink into the main
// checkout's install. The symlinked case is what makes a naive check actively
// harmful: a lane whose branch legitimately bumps a dependency would read as
// stale on EVERY frontend gate, because the shared install matches the owning
// checkout's lockfile rather than the lane's. So the link is resolved and the
// receipt is compared against the OWNER's lockfile; a divergence between the
// lane's own lockfile and the owner's is reported as a warning, never a
// failure, and its remedy removes the symlink first. A bare `npm ci` inside a
// lane writes *through* the link and mutates every concurrent lane's tree.
//
// Fails to UNVERIFIABLE, never to DRIFT. Node exits 1 on an uncaught throw, and
// 1 is the code that means "your install has drifted" -- so a crashed
// comparator would confidently report the one verdict that is certainly wrong.
// Every unexpected throw is caught and re-coded to 2.
//
// Logic is exported for the meta-test; running the file directly performs the
// check.

import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { argv, exit, stderr, stdout } from "node:process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FRONTEND_DIR = join(HERE, "..", "..", "frontend");

export const EXIT = { CLEAN: 0, DRIFT: 1, UNVERIFIABLE: 2 };

// How many offenders the failure text names before it summarises the rest.
const MAX_REPORTED = 5;

// The npm-written receipt, relative to the resolved node_modules.
const RECEIPT_NAME = ".package-lock.json";

// A locked entry that is absent from the receipt is only an offence when npm
// would have had to install it everywhere. An optional or platform-gated entry
// is legitimately absent on some hosts and some npm majors resolve it into the
// receipt while others do not, so its absence is not evidence of staleness. A
// genuinely stale install still shows up as version mismatches on the entries
// that remain.
const PLATFORM_GATED_KEYS = ["optional", "devOptional", "os", "cpu"];

/** True when a lockfile entry may legitimately be absent from an install. */
export function isPlatformGated(entry) {
  return PLATFORM_GATED_KEYS.some((key) => entry?.[key] !== undefined);
}

/**
 * Return the comparable package entries of a lockfile.
 *
 * The `""` root entry describes the project itself rather than an install, and
 * npm does not write one into the receipt at all; comparing it would be a
 * guaranteed false positive. `link: true` entries are workspace pointers whose
 * version lives elsewhere.
 */
export function packageEntries(lock) {
  const packages = lock?.packages;
  if (typeof packages !== "object" || packages === null) {
    throw new Error("lockfile has no `packages` object");
  }
  const entries = new Map();
  for (const [name, entry] of Object.entries(packages)) {
    if (name === "" || entry?.link === true) continue;
    entries.set(name, entry ?? {});
  }
  return entries;
}

/**
 * Compare an install receipt against a committed lockfile.
 *
 * Walks the union of both key sets, so a package installed but not pinned is
 * caught alongside one pinned but not installed. Returns a list of offences,
 * each naming the package and both versions.
 */
export function compareReceipt(receipt, locked) {
  const offences = [];
  for (const [name, lockedEntry] of locked) {
    const installedEntry = receipt.get(name);
    if (installedEntry === undefined) {
      if (isPlatformGated(lockedEntry)) continue;
      offences.push({ name, installed: "absent", locked: lockedEntry.version ?? "unknown" });
      continue;
    }
    if (installedEntry.version !== lockedEntry.version) {
      offences.push({
        name,
        installed: installedEntry.version ?? "unknown",
        locked: lockedEntry.version ?? "unknown",
      });
    }
  }
  for (const [name, installedEntry] of receipt) {
    if (locked.has(name)) continue;
    offences.push({ name, installed: installedEntry.version ?? "unknown", locked: "absent" });
  }
  return offences;
}

/**
 * Compare on-disk package manifests against a committed lockfile.
 *
 * The fallback for a tree npm did not write a receipt into. The set is derived
 * from the lockfile's own root entry rather than a hand-listed sentinel table,
 * so it cannot go stale as the manifest changes.
 */
export function compareOnDisk(nodeModulesDir, locked, rootEntry) {
  const declared = [
    ...Object.keys(rootEntry?.dependencies ?? {}),
    ...Object.keys(rootEntry?.devDependencies ?? {}),
  ];
  const offences = [];
  let verified = 0;
  for (const name of declared) {
    const lockedEntry = locked.get(`node_modules/${name}`);
    if (lockedEntry === undefined || isPlatformGated(lockedEntry)) continue;
    const manifest = join(nodeModulesDir, name, "package.json");
    if (!existsSync(manifest)) {
      offences.push({ name, installed: "absent", locked: lockedEntry.version ?? "unknown" });
      continue;
    }
    verified += 1;
    const installed = JSON.parse(readFileSync(manifest, "utf8"))?.version;
    if (installed !== lockedEntry.version) {
      offences.push({
        name,
        installed: installed ?? "unknown",
        locked: lockedEntry.version ?? "unknown",
      });
    }
  }
  return { offences, verified };
}

/** Read and parse a JSON file, naming it if it cannot be understood. */
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`cannot read ${path}: ${error.message}`);
  }
}

/**
 * Resolve which of the three tree shapes this checkout has.
 *
 * `realpathSync` gives the owning install for a real and a symlinked tree
 * alike, so the owner's lockfile is derived the same way in both cases.
 */
export function resolveShape(frontendDir) {
  const nodeModules = join(frontendDir, "node_modules");
  if (!existsSync(nodeModules)) return { kind: "absent", nodeModules };
  const symlink = lstatSync(nodeModules).isSymbolicLink();
  const resolved = realpathSync(nodeModules);
  return {
    kind: symlink ? "symlink" : "real",
    nodeModules,
    resolved,
    ownerLockfile: join(dirname(resolved), "package-lock.json"),
  };
}

/** The remedy for this tree shape, spelled so it cannot corrupt a sibling. */
function remedyFor(shape) {
  if (shape.kind === "symlink") {
    // scripts/ralph/FLEET.md: a lane that changes a manifest must replace the
    // symlink with a real install. `rm` on a symlink removes the link, not the
    // target, which is what makes this sequence safe beside concurrent lanes.
    return "rm frontend/node_modules && cd frontend && npm ci";
  }
  return "cd frontend && npm ci";
}

/** Render the failure text: what drifted, how far, and what to run. */
function reportDrift(offences, mode, shape) {
  const shown = offences.slice(0, MAX_REPORTED);
  const lines = [
    `✗ The installed frontend tree does not match frontend/package-lock.json.`,
    `  Verified in ${mode} mode; ${offences.length} package(s) differ:`,
    ...shown.map(
      (offence) => `      ${offence.name}: installed ${offence.installed}, locked ${offence.locked}`,
    ),
  ];
  if (offences.length > shown.length) {
    lines.push(`      ... and ${offences.length - shown.length} more`);
  }
  lines.push(
    ``,
    `  The committed pins are NOT the thing to change. frontend/package.json and`,
    `  frontend/package-lock.json are the source of truth here; the install on`,
    `  disk is what has fallen behind them. Reinstall from the lockfile:`,
    ``,
    `      ${remedyFor(shape)}`,
    ``,
  );
  stderr.write(`${lines.join("\n")}\n`);
}

/**
 * Warn when a lane's own lockfile differs from the shared install's owner.
 *
 * Not a failure: a lane that legitimately bumps a dependency is *expected* to
 * diverge from the main checkout's tree, and failing here would turn every such
 * lane red on every frontend gate for a non-problem.
 */
function warnOnLaneDivergence(shape, laneLockfile) {
  if (shape.kind !== "symlink") return;
  if (!existsSync(laneLockfile) || !existsSync(shape.ownerLockfile)) return;
  if (readFileSync(laneLockfile, "utf8") === readFileSync(shape.ownerLockfile, "utf8")) return;
  stderr.write(
    [
      `! frontend/node_modules is a symlink to ${shape.resolved},`,
      `  whose checkout pins a different package-lock.json than this one. The`,
      `  freshness check above read the OWNING checkout's lockfile, so this is a`,
      `  warning rather than a failure. To lint this branch against its own deps:`,
      ``,
      `      ${remedyFor(shape)}`,
      ``,
      `  Do not run a bare 'npm ci' here: it writes through the symlink and`,
      `  mutates the installed tree of every concurrent worktree.`,
      ``,
    ].join("\n") + "\n",
  );
}

/** Run the check against ``frontendDir`` and return an EXIT code. */
export function check(frontendDir) {
  const laneLockfile = join(frontendDir, "package-lock.json");
  const lanePackageJson = join(frontendDir, "package.json");
  if (!existsSync(laneLockfile) && !existsSync(lanePackageJson)) {
    stdout.write(`note: ${frontendDir} has no package.json or package-lock.json; not checked\n`);
    return EXIT.CLEAN;
  }

  const shape = resolveShape(frontendDir);
  if (shape.kind === "absent") {
    stderr.write(`✗ ${shape.nodeModules} does not exist; nothing to verify.\n`);
    return EXIT.UNVERIFIABLE;
  }

  const lockfilePath = existsSync(shape.ownerLockfile) ? shape.ownerLockfile : laneLockfile;
  if (!existsSync(lockfilePath)) {
    stdout.write(`note: no package-lock.json to verify against; not checked\n`);
    return EXIT.CLEAN;
  }
  const lockfile = readJson(lockfilePath);
  const locked = packageEntries(lockfile);

  const receiptPath = join(shape.resolved, RECEIPT_NAME);
  let offences;
  let mode;
  if (existsSync(receiptPath)) {
    mode = "receipt";
    offences = compareReceipt(packageEntries(readJson(receiptPath)), locked);
  } else {
    mode = "fallback";
    stdout.write(`note: verified in fallback mode (no node_modules/${RECEIPT_NAME})\n`);
    const result = compareOnDisk(shape.resolved, locked, lockfile.packages?.[""]);
    if (result.verified === 0 && result.offences.length === 0) {
      stderr.write(`✗ Verified no packages; the check learned nothing.\n`);
      return EXIT.UNVERIFIABLE;
    }
    offences = result.offences;
  }

  if (offences.length > 0) {
    reportDrift(offences, mode, shape);
    warnOnLaneDivergence(shape, laneLockfile);
    return EXIT.DRIFT;
  }
  warnOnLaneDivergence(shape, laneLockfile);
  return EXIT.CLEAN;
}

function main() {
  const frontendDir = argv[2] ?? DEFAULT_FRONTEND_DIR;
  try {
    return check(frontendDir);
  } catch (error) {
    // Never DRIFT: an error here means the question was not answered, and
    // saying "your install drifted" would be a confident wrong verdict.
    stderr.write(`✗ Could not verify the frontend install: ${error.message}\n`);
    return EXIT.UNVERIFIABLE;
  }
}

if (realpathSync(fileURLToPath(import.meta.url)) === realpathSync(argv[1] ?? "")) {
  exit(main());
}
