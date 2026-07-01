/** Intent-rule predicate: ranking/shaming the person is banned, ascending model vocabulary is not. */

const RANK_OR_SHAME_PATTERNS: readonly RegExp[] = [
  // Ranking the user against a fixed scale or each other.
  /you.?re only at level \d/i,
  /you are at level \d/i,
  /you.?re at stage \d+ of/i,
  /\brank \d/i,
  /\branked\b/i,
  /\bleaderboard\b/i,
  // Gating framed as pressure to climb.
  /climb to unlock/i,
  /unlock the next/i,
  /reach the next to unlock/i,
  // Behind/inferior/comparison framing.
  /\bbehind\b/i,
  /fall(ing)? behind/i,
  /catch up/i,
  /ahead of you/i,
  /you.?re inferior/i,
  /further along than you/i,
  // Streak-shame / FOMO pressure.
  /don.?t lose your streak/i,
  /keep your streak/i,
  /streak alive/i,
  /lost your streak/i,
  /broke your streak/i,
  /\bmiss out\b/i,
  /don.?t break/i,
  /\bforever\b/i,
  /keep going/i,
  /\bmust\b/i,
  /don.?t lose/i,
];

/** True when copy ranks or shames the person, per the balance-not-altitude intent rule. */
export function ranksOrShames(copy: string): boolean {
  return RANK_OR_SHAME_PATTERNS.some((pattern) => pattern.test(copy));
}
