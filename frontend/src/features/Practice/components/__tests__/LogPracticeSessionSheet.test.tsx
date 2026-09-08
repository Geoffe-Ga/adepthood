/* eslint-env jest */
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

import type { PracticeSessionCreate, PracticeSessionResponse } from '@/api';

const mockCreate = jest.fn() as jest.MockedFunction<
  (_payload: PracticeSessionCreate) => Promise<PracticeSessionResponse>
>;

jest.mock('@/api', () => ({
  practiceSessions: {
    create: (...args: unknown[]) =>
      (mockCreate as unknown as (..._a: unknown[]) => Promise<PracticeSessionResponse>)(...args),
  },
}));

// eslint-disable-next-line import/order
const { act, fireEvent, render, waitFor } = require('@testing-library/react-native');
const LogPracticeSessionSheet = require('../LogPracticeSessionSheet').default;
const { LOG_SAVE_FALLBACK, LOG_WINDOW_REFUSED_COPY } = require('../LogPracticeSessionSheet') as {
  LOG_SAVE_FALLBACK: string;
  LOG_WINDOW_REFUSED_COPY: string;
};
const { SESSION_WINDOW_COPY, SESSION_WINDOW_HINT } = require('../../utils/sessionWindow') as {
  SESSION_WINDOW_COPY: Record<string, string>;
  SESSION_WINDOW_HINT: string;
};

const NOW = new Date('2026-09-08T15:00:00.000Z');
const DEFAULT_MINUTES = 10;
const MS_PER_MINUTE = 60_000;

const SAVED: PracticeSessionResponse = {
  id: 100,
  user_practice_id: 7,
  duration_minutes: 20,
  timestamp: '2026-09-08T15:00:00.000Z',
  reflection: null,
  mode: 'meditation_timer',
  mode_metadata: null,
  completed: true,
  insight: null,
};

/** A rejection shaped like `ApiError` — the fields `formatApiError` reads. */
function apiError(status: number, detail: string): Error {
  return Object.assign(new Error(`Request failed with status ${status}: ${detail}`), {
    name: 'ApiError',
    status,
    detail,
  });
}

interface Handlers {
  onClose: jest.Mock;
  onSessionApply: jest.Mock;
  onSessionRollback: jest.Mock;
  onSessionCommitted: jest.Mock;
}

function handlers(): Handlers {
  return {
    onClose: jest.fn(),
    onSessionApply: jest.fn(),
    onSessionRollback: jest.fn(),
    onSessionCommitted: jest.fn(),
  };
}

function renderSheet(h: Handlers, userTimezone = 'UTC') {
  return render(
    <LogPracticeSessionSheet
      visible
      userPracticeId={7}
      practiceName="Breath Awareness"
      defaultDurationMinutes={DEFAULT_MINUTES}
      userTimezone={userTimezone}
      {...h}
    />,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCreate.mockResolvedValue(SAVED);
  jest.useFakeTimers().setSystemTime(NOW);
});

afterEach(() => {
  jest.useRealTimers();
});

describe('LogPracticeSessionSheet payload', () => {
  it('submits a window spanning the chosen minutes and never sends a duration', async () => {
    const h = handlers();
    const { getByTestId } = renderSheet(h);

    fireEvent.changeText(getByTestId('log-session-duration'), '20');
    await act(async () => {
      fireEvent.press(getByTestId('log-session-save'));
    });

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const payload = mockCreate.mock.calls[0]?.[0] as PracticeSessionCreate;
    expect(payload.user_practice_id).toBe(7);
    expect(payload.completed).toBe(true);
    expect(payload.ended_at).toBe('2026-09-08T15:00:00.000Z');
    expect(Date.parse(payload.ended_at) - Date.parse(payload.started_at)).toBe(20 * MS_PER_MINUTE);
    expect(payload).not.toHaveProperty('duration_minutes');
    expect(payload).not.toHaveProperty('mode_metadata');
  });

  it("defaults to the practice's own duration and an end of just now", () => {
    const { getByTestId } = renderSheet(handlers());

    expect(getByTestId('log-session-duration').props.value).toBe(String(DEFAULT_MINUTES));
    expect(getByTestId('log-session-ended-label').props.children).toMatch(/^Today, 3:00\s?PM$/);
  });

  it('names the practice being logged', () => {
    const { getByText } = renderSheet(handlers());
    expect(getByText(/Breath Awareness/)).toBeTruthy();
  });
});

describe('LogPracticeSessionSheet end-time stepper', () => {
  it('steps the end time back and renders it in the user timezone', () => {
    const h = handlers();
    const { getByTestId, rerender } = renderSheet(h);

    fireEvent.press(getByTestId('log-session-ended-earlier-hour'));
    fireEvent.press(getByTestId('log-session-ended-earlier-quarter'));
    expect(getByTestId('log-session-ended-label').props.children).toMatch(/^Today, 1:45\s?PM$/);

    rerender(
      <LogPracticeSessionSheet
        visible
        userPracticeId={7}
        practiceName="Breath Awareness"
        defaultDurationMinutes={DEFAULT_MINUTES}
        userTimezone="America/Los_Angeles"
        {...h}
      />,
    );
    expect(getByTestId('log-session-ended-label').props.children).toMatch(/^Today, 6:45\s?AM$/);
  });

  it('will not step the end time past now', () => {
    const { getByTestId } = renderSheet(handlers());

    fireEvent.press(getByTestId('log-session-ended-earlier-hour'));
    for (let i = 0; i < 4; i += 1) {
      fireEvent.press(getByTestId('log-session-ended-later-quarter'));
    }

    expect(getByTestId('log-session-ended-label').props.children).toMatch(/^Today, 3:00\s?PM$/);
    expect(getByTestId('log-session-ended-later-quarter').props.accessibilityState.disabled).toBe(
      true,
    );
    expect(getByTestId('log-session-ended-later-hour').props.accessibilityState.disabled).toBe(
      true,
    );
  });

  it('labels an end time on the previous day as Yesterday', () => {
    const { getByTestId } = renderSheet(handlers());

    // 15:00Z minus 20 hours is 19:00Z the day before.
    for (let i = 0; i < 20; i += 1) {
      fireEvent.press(getByTestId('log-session-ended-earlier-hour'));
    }

    expect(getByTestId('log-session-ended-label').props.children).toMatch(/^Yesterday, 7:00\s?PM$/);
  });
});

describe('LogPracticeSessionSheet window guard', () => {
  it('states the window before anything is wrong', () => {
    const { getByTestId } = renderSheet(handlers());
    expect(getByTestId('log-session-hint').props.children).toBe(SESSION_WINDOW_HINT);
  });

  it('refuses an out-of-window end before spending a request', async () => {
    const { getByTestId } = renderSheet(handlers());

    for (let i = 0; i < 25; i += 1) {
      fireEvent.press(getByTestId('log-session-ended-earlier-hour'));
    }

    expect(getByTestId('log-session-window-note').props.children).toBe(
      SESSION_WINDOW_COPY.started_too_old,
    );
    expect(getByTestId('log-session-save').props.accessibilityState.disabled).toBe(true);
    await act(async () => {
      fireEvent.press(getByTestId('log-session-save'));
    });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('refuses a sitting longer than the server will record', async () => {
    const { getByTestId } = renderSheet(handlers());

    fireEvent.changeText(getByTestId('log-session-duration'), '500');

    expect(getByTestId('log-session-window-note').props.children).toBe(
      SESSION_WINDOW_COPY.too_long,
    );
    expect(getByTestId('log-session-save').props.accessibilityState.disabled).toBe(true);
    await act(async () => {
      fireEvent.press(getByTestId('log-session-save'));
    });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it.each([
    ['an empty duration', ''],
    ['a zero duration', '0'],
    ['a fractional duration', '2.5'],
  ])('asks for whole minutes given %s', async (_label, text) => {
    const { getByTestId } = renderSheet(handlers());

    fireEvent.changeText(getByTestId('log-session-duration'), text);

    expect(getByTestId('log-session-window-note').props.children).toBe(
      'Enter how many whole minutes you practised.',
    );
    expect(getByTestId('log-session-save').props.accessibilityState.disabled).toBe(true);
    await act(async () => {
      fireEvent.press(getByTestId('log-session-save'));
    });
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe('LogPracticeSessionSheet save outcomes', () => {
  it('commits the optimistic increment and closes on success', async () => {
    const h = handlers();
    const { getByTestId, queryByTestId, rerender } = renderSheet(h);

    fireEvent.changeText(getByTestId('log-session-duration'), '20');
    fireEvent.press(getByTestId('log-session-ended-earlier-hour'));
    await act(async () => {
      fireEvent.press(getByTestId('log-session-save'));
    });

    expect(h.onSessionApply).toHaveBeenCalledTimes(1);
    expect(h.onSessionCommitted).toHaveBeenCalledTimes(1);
    expect(h.onSessionRollback).not.toHaveBeenCalled();
    expect(h.onClose).toHaveBeenCalledTimes(1);
    expect(queryByTestId('log-session-error')).toBeNull();

    // Reopening starts from the defaults again, not the last attempt.
    rerender(
      <LogPracticeSessionSheet
        visible={false}
        userPracticeId={7}
        practiceName="Breath Awareness"
        defaultDurationMinutes={DEFAULT_MINUTES}
        userTimezone="UTC"
        {...h}
      />,
    );
    rerender(
      <LogPracticeSessionSheet
        visible
        userPracticeId={7}
        practiceName="Breath Awareness"
        defaultDurationMinutes={DEFAULT_MINUTES}
        userTimezone="UTC"
        {...h}
      />,
    );
    expect(getByTestId('log-session-duration').props.value).toBe(String(DEFAULT_MINUTES));
    expect(getByTestId('log-session-ended-label').props.children).toMatch(/^Today, 3:00\s?PM$/);
  });

  it('rolls back and names the window on a 422 rather than blaming the connection', async () => {
    mockCreate.mockRejectedValueOnce(
      apiError(422, 'Value error, started_at is too far in the past'),
    );
    const h = handlers();
    const { getByTestId } = renderSheet(h);

    await act(async () => {
      fireEvent.press(getByTestId('log-session-save'));
    });

    await waitFor(() => expect(getByTestId('log-session-error')).toBeTruthy());
    expect(getByTestId('log-session-error').props.children).toBe(LOG_WINDOW_REFUSED_COPY);
    expect(getByTestId('log-session-error').props.children).not.toMatch(
      /Check your connection|timer minutes/,
    );
    expect(h.onSessionApply).toHaveBeenCalledTimes(1);
    expect(h.onSessionRollback).toHaveBeenCalledTimes(1);
    expect(h.onSessionCommitted).not.toHaveBeenCalled();
    expect(h.onClose).not.toHaveBeenCalled();
  });

  it('shows the existing stage copy on a 403 stage_locked', async () => {
    mockCreate.mockRejectedValueOnce(apiError(403, 'stage_locked'));
    const h = handlers();
    const { getByTestId } = renderSheet(h);

    await act(async () => {
      fireEvent.press(getByTestId('log-session-save'));
    });

    await waitFor(() => expect(getByTestId('log-session-error')).toBeTruthy());
    expect(getByTestId('log-session-error').props.children).toMatch(
      /^You haven't unlocked this stage yet/,
    );
  });

  it('falls back to its own copy on an unrecognised failure', async () => {
    mockCreate.mockRejectedValueOnce(new Error('socket hang up'));
    const h = handlers();
    const { getByTestId } = renderSheet(h);

    await act(async () => {
      fireEvent.press(getByTestId('log-session-save'));
    });

    await waitFor(() => expect(getByTestId('log-session-error')).toBeTruthy());
    expect(getByTestId('log-session-error').props.children).toBe(LOG_SAVE_FALLBACK);
  });

  it('ignores a second press while the first save is in flight', async () => {
    let release: (_value: PracticeSessionResponse) => void = () => {};
    mockCreate.mockReturnValueOnce(
      new Promise<PracticeSessionResponse>((resolve) => {
        release = resolve;
      }),
    );
    const h = handlers();
    const { getByTestId } = renderSheet(h);

    await act(async () => {
      fireEvent.press(getByTestId('log-session-save'));
    });
    await waitFor(() =>
      expect(getByTestId('log-session-save').props.accessibilityState.disabled).toBe(true),
    );
    fireEvent.press(getByTestId('log-session-save'));
    expect(mockCreate).toHaveBeenCalledTimes(1);

    await act(async () => {
      release(SAVED);
    });
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('closes without saving when the sitting is dismissed', () => {
    const h = handlers();
    const { getByTestId } = renderSheet(h);

    fireEvent.press(getByTestId('log-session-cancel'));

    expect(h.onClose).toHaveBeenCalledTimes(1);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(h.onSessionApply).not.toHaveBeenCalled();
  });
});

describe('LogPracticeSessionSheet accessibility', () => {
  it('labels its controls with the text they show', () => {
    const { getByTestId, getByLabelText } = renderSheet(handlers());

    expect(getByTestId('log-session-save').props.accessibilityRole).toBe('button');
    expect(getByTestId('log-session-cancel').props.accessibilityRole).toBe('button');
    expect(getByLabelText('Log this practice')).toBeTruthy();
    expect(getByLabelText('Cancel')).toBeTruthy();
    expect(getByLabelText('An hour earlier')).toBeTruthy();
    expect(getByLabelText('Fifteen minutes later')).toBeTruthy();
  });
});
