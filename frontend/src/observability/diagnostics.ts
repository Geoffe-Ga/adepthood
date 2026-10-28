/** Client failure records have a closed vocabulary and no prose-bearing argument. */
const SEVERITY = {
  crash_caught: 'error',
  diagnostic_input_rejected: 'warn',
  api_server_error: 'warn',
  api_response_invalid: 'warn',
  auth_refresh_invalid: 'warn',
  storage_corrupt: 'warn',
  storage_read_failed: 'warn',
  storage_write_failed: 'warn',
  storage_clear_failed: 'warn',
  auth_storage_failed: 'warn',
  provider_storage_failed: 'warn', // pragma: allowlist secret -- fixed diagnostic severity, no credential
  store_reset_failed: 'warn',
  course_load_failed: 'error',
  course_read_failed: 'error',
  map_load_failed: 'error',
  map_begin_again_failed: 'error',
  linked_habit_failed: 'warn',
  quick_session_record_failed: 'warn',
  offer_persistence_failed: 'warn',
  habit_ui_failed: 'warn',
  habit_save_failed: 'error',
  habit_update_failed: 'error',
  habits_load_failed: 'error',
  habit_recovery_failed: 'warn',
  goal_recovery_failed: 'warn',
  quarantine_clear_failed: 'warn',
  checkin_rejected: 'warn',
  checkin_gave_up: 'warn',
  notification_registration_failed: 'error',
  notification_update_failed: 'error',
  notification_schedule_retry: 'warn',
  notification_schedule_failed: 'error',
  notification_reconcile_failed: 'error',
  notification_cancel_failed: 'error',
  audio_session_failed: 'warn',
  audio_cue_unavailable: 'warn',
  photo_picker_failed: 'warn',
  unknown_stage_progress: 'warn',
  capture_cleanup_failed: 'warn',
} as const;

export type DiagnosticCode = keyof typeof SEVERITY;

const STORAGE_CATEGORIES = [
  'auth',
  'api_key',
  'habits',
  'pending_checkins',
  'quarantine',
  'recent_practices',
  'user_scope',
  'welcome',
  'program',
  'notifications',
  'writing_offer',
  'reflection_dismissal',
  'return_offer',
  'voice_readiness',
  'promote_explainer',
  'resonance_explainer',
  'morning_pages',
  'local_model',
  'link_habit_nudge',
  'pagination_visibility',
  'writing_habit_link',
  'corpus_sweep_offer',
  'unknown',
] as const;

const ROUTES = [
  '/auth/login',
  '/auth/signup',
  '/auth/refresh',
  '/journal/',
  '/journal/{entry_id}',
  '/journal/{entry_id}/notes',
  '/journal/{entry_id}/reflect',
  '/habits/',
  '/habits/{habit_id}',
  '/habits/{habit_id}/story',
  '/goals/{goal_id}',
  '/goal_completions/',
  '/users/me',
  '/users/me/timezone',
  'unknown_route',
] as const;

export type DiagnosticRoute = (typeof ROUTES)[number];

/** Adding fields requires a privacy review; arbitrary context/error/message is absent. */
export interface DiagnosticMetadata {
  storage?: (typeof STORAGE_CATEGORIES)[number];
  route?: DiagnosticRoute;
  status?: number;
  count?: number;
  issueCount?: number;
  attempt?: number;
  stage?: number;
  progress?: number;
  requestId?: string;
}

/** The backend mints UUID4 hex; its wider inbound header alphabet is not prose-safe. */
export function safeDiagnosticRequestId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  // UUID4's version nibble is 4; its variant nibble is 8, 9, a or b.
  return /^(?:[0-9a-f]{12}4[0-9a-f]{3}[89ab][0-9a-f]{15}|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.test(
    value,
  )
    ? value
    : undefined;
}

/** Match known templates without retaining numeric IDs or search/query text. */
export function diagnosticRoute(path: string): DiagnosticRoute {
  const pathname = path.split('?')[0] ?? '';
  if (ROUTES.includes(pathname as DiagnosticRoute)) return pathname as DiagnosticRoute;
  const matches: Array<[RegExp, DiagnosticRoute]> = [
    [/^\/journal\/\d+\/?$/, '/journal/{entry_id}'],
    [/^\/journal\/\d+\/notes\/?$/, '/journal/{entry_id}/notes'],
    [/^\/journal\/\d+\/reflect\/?$/, '/journal/{entry_id}/reflect'],
    [/^\/habits\/\d+\/?$/, '/habits/{habit_id}'],
    [/^\/habits\/\d+\/story\/?$/, '/habits/{habit_id}/story'],
    [/^\/goals\/\d+\/?$/, '/goals/{goal_id}'],
  ];
  return matches.find(([pattern]) => pattern.test(pathname))?.[1] ?? 'unknown_route';
}

function bounded(value: unknown, maximum: number): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.min(value, maximum)
    : undefined;
}

function safeStatus(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : undefined;
}

function collectMetadata(valueOf: (key: keyof DiagnosticMetadata) => unknown): DiagnosticMetadata {
  const result: DiagnosticMetadata = {};
  const storage = valueOf('storage');
  const route = valueOf('route');
  if (STORAGE_CATEGORIES.includes(storage as NonNullable<DiagnosticMetadata['storage']>))
    result.storage = storage as DiagnosticMetadata['storage'];
  if (ROUTES.includes(route as DiagnosticRoute)) result.route = route as DiagnosticRoute;
  const status = safeStatus(valueOf('status'));
  if (status !== undefined) result.status = status;
  for (const key of ['count', 'issueCount', 'attempt', 'stage', 'progress'] as const) {
    const cap = key === 'count' || key === 'issueCount' ? 10_000 : 100;
    const value = bounded(valueOf(key), cap);
    if (value !== undefined) result[key] = value;
  }
  const requestId = safeDiagnosticRequestId(valueOf('requestId'));
  if (requestId !== undefined) result.requestId = requestId;
  return result;
}

function safeMetadata(metadata: DiagnosticMetadata): DiagnosticMetadata {
  try {
    const fields = Object.getOwnPropertyDescriptors(metadata);
    return collectMetadata((key) => {
      const descriptor = fields[key];
      return descriptor && 'value' in descriptor ? descriptor.value : undefined;
    });
  } catch {
    // A hostile proxy must not disrupt the recovery caller.
    return {};
  }
}

export function reportDiagnostic(code: DiagnosticCode, metadata?: DiagnosticMetadata): void {
  const known = typeof code === 'string' && Object.hasOwn(SEVERITY, code);
  const safeCode = known ? code : 'diagnostic_input_rejected';
  const safe = metadata ? safeMetadata(metadata) : {};
  const args: [DiagnosticCode] | [DiagnosticCode, DiagnosticMetadata] = Object.keys(safe).length
    ? [safeCode, safe]
    : [safeCode];
  console[SEVERITY[safeCode]](...args);
}
