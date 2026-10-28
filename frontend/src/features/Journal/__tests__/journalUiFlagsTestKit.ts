import type { UiFlags } from '@/api';

/** A server-confirmed unlinked account for ordinary Journal screen reads. */
export const uiFlags = {
  get: async (_token?: string): Promise<UiFlags> => ({
    has_seen_welcome: true,
    energy_scaffolding_archived: false,
    writing_session_habit_id: null,
    course_last_stage: null,
  }),
};
