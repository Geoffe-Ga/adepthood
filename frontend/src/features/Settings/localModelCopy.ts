/**
 * Everything the "Use Adepthood's own model" switch says, in one place so it
 * can be checked. "Local" is the open-source model Adepthood runs on servers
 * it operates — not a model on the device, and not a provider reached with a
 * key the person brought. The promises here are the ones that model is run
 * under; nothing below describes a provider's terms, which are the provider's.
 */

export const LOCAL_MODEL_SWITCH_LABEL = "Use Adepthood's own model";

/** What the model is, and the four things it is not done with your writing. */
export const LOCAL_MODEL_SWITCH_DESCRIPTION =
  'An open-source model running on servers Adepthood operates. It does not read, keep, or sell your writing, does not train on it, and builds no profile of you to sell anything with.';

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
  LOCAL_MODEL_ON_NOTE,
  LOCAL_MODEL_OFF_NOTE,
  LOCAL_MODEL_SAVE_FAILED,
];
