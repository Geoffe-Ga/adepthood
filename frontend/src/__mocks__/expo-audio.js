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

module.exports = { createAudioPlayer };
