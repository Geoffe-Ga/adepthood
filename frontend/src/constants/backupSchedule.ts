/**
 * How long, on the backup schedule, a backup taken before an account is
 * deleted can still hold a copy of it: the oldest live copy across Adepthood's
 * backup legs (the platform's own backups and the operator's off-host dumps).
 *
 * CROSS-STACK CONTRACT: mirrors ``OLDEST_LIVE_BACKUP_DAYS`` in
 * ``backend/src/domain/retention_stores.py``, which derives it from
 * ``DEPLOYMENT.md``'s backup table. ``backend/tests/test_deletion_backup_copy.py``
 * reads this declaration and pins it to the backend figure, and the
 * delete-account Jest suite pins it to the same literal (#3115).
 *
 * It is the schedule's figure, not an enforced guarantee: copy that states it
 * must frame it as such.
 */
export const OLDEST_LIVE_BACKUP_DAYS = 97;
