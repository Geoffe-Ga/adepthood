/**
 * How long, on the backup schedule, a backup taken before an account is
 * deleted can still hold a copy of it: the oldest live copy across Adepthood's
 * backups (the platform's own, and any dump still held from the off-host leg
 * the owner retired on 2026-10-14, #3260).
 *
 * CROSS-STACK CONTRACT: mirrors ``OLDEST_LIVE_BACKUP_DAYS`` in
 * ``backend/src/domain/retention_stores.py``, which derives it from
 * ``DEPLOYMENT.md``'s backup table. ``backend/tests/test_deletion_backup_copy.py``
 * reads this declaration and pins it to the backend figure, and the
 * delete-account Jest suite derives that figure from the backend source and
 * holds this constant to it, so either side's CI catches a one-sided change
 * (#3115).
 *
 * It is the schedule's figure, not an enforced guarantee: copy that states it
 * must frame it as such.
 */
export const OLDEST_LIVE_BACKUP_DAYS = 97;
