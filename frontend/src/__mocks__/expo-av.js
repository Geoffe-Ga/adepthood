/* global jest */
const Sound = {
  createAsync: jest.fn().mockResolvedValue({
    sound: {
      playAsync: jest.fn().mockResolvedValue(undefined),
      unloadAsync: jest.fn().mockResolvedValue(undefined),
    },
  }),
};

const Audio = { Sound };

module.exports = { Audio };
