/* global jest */
const ImpactFeedbackStyle = { Light: 'light', Medium: 'medium', Heavy: 'heavy' };
const NotificationFeedbackType = { Success: 'success', Warning: 'warning', Error: 'error' };

module.exports = {
  ImpactFeedbackStyle,
  NotificationFeedbackType,
  impactAsync: jest.fn().mockResolvedValue(undefined),
  notificationAsync: jest.fn().mockResolvedValue(undefined),
  selectionAsync: jest.fn().mockResolvedValue(undefined),
};
