/** Auth marks legacy resumed calendars provisional until the server confirms them. */
const pendingOwners = new Set<number | null>();

export function setUserTimezonePending(owner: number | null, pending: boolean): void {
  if (pending) pendingOwners.add(owner);
  else pendingOwners.delete(owner);
}

export function isUserTimezonePending(owner: number | null): boolean {
  return pendingOwners.has(owner);
}
