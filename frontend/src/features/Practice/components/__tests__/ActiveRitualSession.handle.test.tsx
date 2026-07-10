// RED: ActiveRitualSession is not yet a forwardRef component and does not
// export ActiveRitualSessionHandle -- both fail to compile/resolve until the
// implementation-specialist adds openConfigurator() via useImperativeHandle.
import { describe, expect, it } from '@jest/globals';
import { act, render } from '@testing-library/react-native';
import React, { createRef } from 'react';

import type { UserPractice } from '@/api';
import ActiveRitualSession, {
  type ActiveRitualSessionHandle,
} from '@/features/Practice/components/ActiveRitualSession';
import type { MeditationTimerConfig } from '@/features/Practice/engine/types';

const userPractice: UserPractice = {
  id: 10,
  practice_id: 1,
  stage_number: 1,
  start_date: '2026-04-12',
  end_date: null,
};

const config: MeditationTimerConfig = {
  mode: 'meditation_timer',
  duration_minutes: 10,
  halfway_bell: true,
};

function renderSession(ref: React.Ref<ActiveRitualSessionHandle>) {
  return render(
    <ActiveRitualSession
      ref={ref}
      userPractice={userPractice}
      effectiveName="Breath Awareness"
      effectiveConfig={config}
      userTimezone="UTC"
      onSessionApply={() => {}}
      onSessionRollback={() => {}}
      onSessionCommitted={() => {}}
      onUserPracticeUpdated={() => {}}
      onWriteReflection={() => {}}
    />,
  );
}

describe('ActiveRitualSession imperative handle', () => {
  it('opens the configurator sheet when openConfigurator is called via ref', () => {
    const ref = createRef<ActiveRitualSessionHandle>();
    const { getByTestId } = renderSession(ref);

    act(() => {
      ref.current?.openConfigurator();
    });

    expect(getByTestId('ritual-configurator-sheet')).toBeTruthy();
  });
});
