/**
 * Everything the future Adepthood-model choice says, in one place so it can
 * be checked. Until an Adepthood-operated provider exists, the control is a
 * disabled coming-soon row and makes no present-tense routing or privacy
 * promise. The release gate must only be opened alongside the real provider.
 */

export const LOCAL_MODEL_SWITCH_LABEL = "Adepthood's own model — coming soon";

/** What is planned, explicitly not what routes requests today. */
export const LOCAL_MODEL_SWITCH_DESCRIPTION =
  'Adepthood plans to offer an open-source model on servers Adepthood operates. This option is not available yet.';

/** Shown while the release gate is closed. */
export const LOCAL_MODEL_UNAVAILABLE_NOTE =
  'Requests still use the API key you add below, or the shared provider when no key is saved.';

/** Under the switch while it is on: what is in use, and what the key is not. */
export const LOCAL_MODEL_ON_NOTE =
  "Drafts and sorting use Adepthood's model. A key saved below stays on this device and is not sent while this is on.";

/** Under the switch while it is off: the key is the way. */
export const LOCAL_MODEL_OFF_NOTE = 'Off, so requests use the API key you add below.';

/** Said when the device could not keep the choice: it holds, but not past this session. */
export const LOCAL_MODEL_SAVE_FAILED =
  "That choice couldn't be kept on this device, so it holds only until you close the app. Try again after restarting.";

/** Every string above, for a copy sweep. */
export const LOCAL_MODEL_COPY_ENTRIES: readonly string[] = [
  LOCAL_MODEL_SWITCH_LABEL,
  LOCAL_MODEL_SWITCH_DESCRIPTION,
  LOCAL_MODEL_UNAVAILABLE_NOTE,
  LOCAL_MODEL_ON_NOTE,
  LOCAL_MODEL_OFF_NOTE,
  LOCAL_MODEL_SAVE_FAILED,
];
