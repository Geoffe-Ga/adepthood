import { useCallback, useState } from 'react';

export type ModalName =
  | 'goal'
  | 'stats'
  | 'settings'
  | 'reorder'
  | 'missedDays'
  | 'onboarding'
  | 'emojiPicker';

interface ModalState {
  goal: boolean;
  stats: boolean;
  settings: boolean;
  reorder: boolean;
  missedDays: boolean;
  onboarding: boolean;
  emojiPicker: boolean;
}

const INITIAL_STATE: ModalState = {
  goal: false,
  stats: false,
  settings: false,
  reorder: false,
  missedDays: false,
  onboarding: false,
  emojiPicker: false,
};

export interface ModalCoordinator extends ModalState {
  menu: boolean;
  open: (_name: ModalName) => void;
  close: (_name: ModalName) => void;
  closeAll: () => void;
  toggleMenu: () => void;
}

export const useModalCoordinator = (): ModalCoordinator => {
  const [modals, setModals] = useState<ModalState>(INITIAL_STATE);
  const [menu, setMenu] = useState(false);

  const open = useCallback((name: ModalName) => {
    setModals({ ...INITIAL_STATE, [name]: true });
    setMenu(false);
  }, []);

  const close = useCallback((name: ModalName) => {
    setModals((prev) => ({ ...prev, [name]: false }));
  }, []);

  const closeAll = useCallback(() => {
    setModals(INITIAL_STATE);
    setMenu(false);
  }, []);

  const toggleMenu = useCallback(() => {
    setMenu((prev) => !prev);
  }, []);

  return {
    ...modals,
    menu,
    open,
    close,
    closeAll,
    toggleMenu,
  };
};
