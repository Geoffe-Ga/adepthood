/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { act, renderHook } from '@testing-library/react-native';

/**
 * One promote note in front of both doors to Promote on a reading surface
 * (#3661): "Promote a quote", which opens the selection field, and the pill
 * over a passage highlighted on the rendered page, which promotes it outright.
 */
import { usePromoteGate } from '../usePromoteGate';

const mockLoad = jest.fn<() => Promise<boolean>>();
const mockSave = jest.fn<(_value: boolean) => Promise<void>>();

jest.mock('@/storage/promoteExplainerStorage', () => ({
  loadPromoteExplainerDismissed: () => mockLoad(),
  savePromoteExplainerDismissed: (value: boolean) => mockSave(value),
}));

const PASSAGE = { start: 4, end: 19 };

async function renderGate(dismissed: boolean) {
  mockLoad.mockResolvedValue(dismissed);
  const startSelecting = jest.fn();
  const promoteSpan = jest.fn();
  const hook = renderHook(() => usePromoteGate(startSelecting, promoteSpan));
  // Let the warm read at mount settle, as it has by the time a reader presses.
  await act(async () => undefined);
  return { ...hook, startSelecting, promoteSpan };
}

beforeEach(() => {
  mockLoad.mockReset();
  mockSave.mockReset();
  mockSave.mockResolvedValue(undefined);
});

describe('usePromoteGate', () => {
  it('a reader who turned the note off: the pill promotes the passage straight away', async () => {
    const { result, startSelecting, promoteSpan } = await renderGate(true);
    act(() => result.current.promotePassage(PASSAGE));
    expect(promoteSpan).toHaveBeenCalledWith(PASSAGE);
    expect(startSelecting).not.toHaveBeenCalled();
    expect(result.current.explainer.visible).toBe(false);
  });

  it('a reader who turned the note off: Promote a quote opens the field straight away', async () => {
    const { result, startSelecting, promoteSpan } = await renderGate(true);
    act(() => result.current.openSelection());
    expect(startSelecting).toHaveBeenCalledTimes(1);
    expect(promoteSpan).not.toHaveBeenCalled();
  });

  it('a new reader: the pill shows the note for a chosen passage, and its go-ahead promotes it', async () => {
    const { result, startSelecting, promoteSpan } = await renderGate(false);
    act(() => result.current.promotePassage(PASSAGE));
    expect(result.current.explainer.visible).toBe(true);
    expect(result.current.passageChosen).toBe(true);
    expect(promoteSpan).not.toHaveBeenCalled();

    act(() => result.current.explainer.onContinue());
    expect(promoteSpan).toHaveBeenCalledWith(PASSAGE);
    expect(startSelecting).not.toHaveBeenCalled();
  });

  it('a new reader: Promote a quote shows the note for choosing a passage, and its go-ahead opens the field', async () => {
    const { result, startSelecting, promoteSpan } = await renderGate(false);
    act(() => result.current.promotePassage(PASSAGE));
    act(() => result.current.explainer.onCancel());
    act(() => result.current.openSelection());
    expect(result.current.passageChosen).toBe(false);

    act(() => result.current.explainer.onContinue());
    expect(startSelecting).toHaveBeenCalledTimes(1);
    // The passage the reader walked away from is not promoted behind their back.
    expect(promoteSpan).not.toHaveBeenCalled();
  });

  it('a tick in front of one door is honoured at the other: one stored dismissal', async () => {
    const { result, startSelecting, promoteSpan } = await renderGate(false);
    act(() => result.current.openSelection());
    act(() => result.current.explainer.onToggleDontShowAgain());
    act(() => result.current.explainer.onContinue());
    expect(startSelecting).toHaveBeenCalledTimes(1);

    act(() => result.current.promotePassage(PASSAGE));
    expect(result.current.explainer.visible).toBe(false);
    expect(promoteSpan).toHaveBeenCalledWith(PASSAGE);
    expect(mockSave).toHaveBeenCalledWith(true);
  });
});
