export interface EmojiSelectionPayload {
  emoji: string;
  unified: string;
  shortcodes: string[];
  skinToneApplied?: number;
}

export interface EmojiPrefsResponse {
  preferred_skin_tone?: number | null;
  recents: string[];
}
