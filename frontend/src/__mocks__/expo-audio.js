/* global jest */
// expo-audio replaces expo-av, whose mock had drifted: it exposed `playAsync`
// while the adapter actually called `replayAsync`, so the mock never exercised
// the path under test. This one mirrors the three operations the adapter really
// performs, and no more.
//
// createAudioPlayer is SYNCHRONOUS in expo-audio -- it returns a player and
// loads in the background -- so this must not return a promise.
const createAudioPlayer = jest.fn(() => ({
  seekTo: jest.fn().mockResolvedValue(undefined),
  play: jest.fn(),
  remove: jest.fn(),
}));

// The adapter asks for playback in silent mode once per app session. iOS
// defaults `playsInSilentMode` to false, so without this call a meditation bell
// is inaudible whenever the ringer switch is off; it is a no-op on web.
const setAudioModeAsync = jest.fn().mockResolvedValue(undefined);

module.exports = { createAudioPlayer, setAudioModeAsync };
