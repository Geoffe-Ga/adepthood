import { useCallback, useState } from 'react';

export type ModalName =
  | 'goal'
  | 'stats'
  | 'settings'
  | 'reorder'
  | 'missedDays'
  | 'onboarding'
  | 'addHabit'
  | 'emojiPicker';

interface ModalState {
  goal: boolean;
  stats: boolean;
  settings: boolean;
  reorder: boolean;
  missedDays: boolean;
  onboarding: boolean;
  addHabit: boolean;
  emojiPicker: boolean;
}

const INITIAL_STATE: ModalState = {
  goal: false,
  stats: false,
  settings: false,
  reorder: false,
  missedDays: false,
  onboarding: false,
  addHabit: false,
  emojiPicker: false,
};

export interface ModalCoordinator extends ModalState {
  open: (_name: ModalName) => void;
  close: (_name: ModalName) => void;
  closeAll: () => void;
}

export const useModalCoordinator = (): ModalCoordinator => {
  const [modals, setModals] = useState<ModalState>(INITIAL_STATE);

  const open = useCallback((name: ModalName) => {
    // BUG-FE-HABIT-008: previously this resolved to ``{ [name]: true }``
    // -- which silently closed every other open modal.  ``onboarding``
    // raising the ``stats`` modal mid-flow would dismiss onboarding,
    // and the count-warning toast inside ``OnboardingModal`` would
    // close its host.  Preserving prior flags lets the screen stack
    // modals when the UX requires it; callers that need exclusivity
    // call ``closeAll`` first.
    setModals((prev) => ({ ...prev, [name]: true }));
  }, []);

  const close = useCallback((name: ModalName) => {
    setModals((prev) => ({ ...prev, [name]: false }));
  }, []);

  const closeAll = useCallback(() => {
    setModals(INITIAL_STATE);
  }, []);

  return {
    ...modals,
    open,
    close,
    closeAll,
  };
};
