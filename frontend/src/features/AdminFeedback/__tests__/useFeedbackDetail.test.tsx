import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, renderHook, waitFor } from '@testing-library/react-native';

import { useFeedbackDetail } from '../useFeedbackDetail';

import { detail } from './fixtures';

import { ApiError, type FeedbackTriageDetailT } from '@/api';

type Detail = Promise<FeedbackTriageDetailT>;
const mockDetail = jest.fn<(_id: string) => Detail>();
const mockTransition = jest.fn<(_id: string, _status: string) => Detail>();
const mockNote = jest.fn<(_id: string, _body: string) => Detail>();

jest.mock('@/api', () => {
  const actual = jest.requireActual<Record<string, unknown>>('@/api');
  return {
    ...actual,
    adminFeedback: {
      detail: (id: string) => mockDetail(id),
      transition: (id: string, status: string) => mockTransition(id, status),
      addNote: (id: string, body: string) => mockNote(id, body),
    },
  };
});
jest.mock('@/context/AuthContext', () => ({ useAuth: () => ({ token: 'operator-token' }) }));

const FIRST = 'FB-AAAAAAAA';
const SECOND = 'FB-BBBBBBBB';
const HTTP_SERVER_ERROR = 500;

beforeEach(() => {
  mockDetail.mockReset();
  mockTransition.mockReset();
  mockNote.mockReset();
  mockDetail.mockImplementation((id: string) => Promise.resolve(detail({ public_id: id })));
});

describe('useFeedbackDetail', () => {
  it('ignores a change that answers after the operator opened another report', async () => {
    let answer: (_value: FeedbackTriageDetailT) => void = () => undefined;
    mockTransition.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    const { result, rerender } = renderHook(({ id }: { id: string }) => useFeedbackDetail(id), {
      initialProps: { id: FIRST },
    });
    await waitFor(() => expect(result.current.detail?.public_id).toBe(FIRST));

    act(() => {
      result.current.transition('triaged');
    });
    rerender({ id: SECOND });
    await waitFor(() => expect(result.current.detail?.public_id).toBe(SECOND));
    await act(async () => {
      answer(detail({ public_id: FIRST }));
    });

    expect(result.current.detail?.public_id).toBe(SECOND);
  });

  it('tells its owner a change landed, and not when it failed', async () => {
    const onChanged = jest.fn();
    mockTransition.mockResolvedValueOnce(detail({ public_id: FIRST }));
    mockTransition.mockRejectedValueOnce(new ApiError(HTTP_SERVER_ERROR, 'server_error'));
    const { result } = renderHook(() => useFeedbackDetail(FIRST, onChanged));
    await waitFor(() => expect(result.current.detail).not.toBeNull());

    await act(async () => {
      await result.current.transition('triaged');
    });
    expect(onChanged).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.transition('planned');
    });
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(result.current.actionFailed).toBe(true);
  });

  it('reports whether a note was saved', async () => {
    mockNote.mockResolvedValueOnce(detail({ public_id: FIRST }));
    mockNote.mockRejectedValueOnce(new ApiError(HTTP_SERVER_ERROR, 'server_error'));
    const { result } = renderHook(() => useFeedbackDetail(FIRST));
    await waitFor(() => expect(result.current.detail).not.toBeNull());

    let saved: boolean | undefined;
    await act(async () => {
      saved = await result.current.addNote('kept');
    });
    expect(saved).toBe(true);
    await act(async () => {
      saved = await result.current.addNote('lost?');
    });
    expect(saved).toBe(false);
  });
});
