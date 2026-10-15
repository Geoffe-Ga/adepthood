/** Explicit web passage ↔ note navigation; native keeps its existing open action. */
import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Platform } from 'react-native';
import type { ScrollView, View } from 'react-native';

import {
  isNavigationRoot,
  isNavigationScroller,
  revealMarginTarget,
} from './marginNavigationScroll';
import { drawnNoteIds } from './renderedSpans';

import type { Marginalia, PromotedQuote } from '@/api';
import { useReducedMotionSetting } from '@/hooks/useReducedMotion';

/** Never guess a new passage for an obsolete snapshot; keep its note visibly stale. */
function noteAnchorStale(note: Marginalia, body: string): boolean {
  return (
    note.status === 'stale' ||
    Array.from(body).slice(note.anchor_start, note.anchor_end).join('') !== note.anchor_text
  );
}
/** A loaded, drawn note is the only object allowed to choose a navigation target. */
export function noteNavigationAllowed(
  note: Marginalia,
  body: string,
  notes: readonly Marginalia[],
  drawn: ReadonlySet<number>,
): boolean {
  return !noteAnchorStale(note, body) && notes.includes(note) && drawn.has(note.id);
}

interface MarginNavigation {
  selectedId: number | null;
  isCurrent: () => boolean;
  canNavigate: (_note: Marginalia) => boolean;
  isStale: (_note: Marginalia) => boolean;
  fromPassage: (_note: Marginalia, _open: (_note: Marginalia) => void) => void;
  fromNote: (_note: Marginalia) => boolean;
}
const Context = createContext<MarginNavigation | null>(null);
export function useMarginNavigation(): MarginNavigation | null {
  return useContext(Context);
}

interface Props {
  enabled?: boolean;
  body: string;
  notes: Marginalia[];
  quotes: PromotedQuote[];
  pageRef: React.RefObject<View | null>;
  scrollRef: React.RefObject<ScrollView | null>;
  children: React.ReactNode;
}

/** Each page snapshot owns its continuation, including across unmount and retained handlers. */
function useNavigationLifetime(identity: object) {
  const live = useRef<object | null>(identity);
  live.current = identity;
  const pending = useRef<{ identity: object; cancel: () => void } | null>(null);
  useEffect(() => {
    live.current = identity;
    return () => {
      if (live.current === identity) live.current = null;
      if (pending.current?.identity === identity) {
        pending.current.cancel();
        pending.current = null;
      }
    };
  }, [identity]);
  return {
    isCurrent: () => live.current === identity,
    cancel: () => {
      pending.current?.cancel();
      pending.current = null;
    },
    retain: (cancel: () => void) => {
      if (live.current === identity) pending.current = { identity, cancel };
      else cancel();
    },
  };
}

type NavigationBindings = Pick<Props, 'pageRef' | 'scrollRef'> & {
  lifetime: ReturnType<typeof useNavigationLifetime>;
  reducedMotion: boolean | null;
  canNavigate: (_note: Marginalia) => boolean;
  onSelected: (_id: number) => void;
};

/** The DOM bridge is read-mode only; every invocation is fenced before reading current refs. */
function revealOnPage(
  bindings: NavigationBindings,
  note: Marginalia,
  destination: 'passage' | 'note',
  done: () => void,
): boolean {
  if (!bindings.canNavigate(note)) return false;
  const { pageRef, scrollRef, lifetime, reducedMotion } = bindings;
  const root = pageRef.current;
  const scroll: unknown = scrollRef.current?.getScrollableNode();
  if (!isNavigationRoot(root) || !isNavigationScroller(scroll)) return false;
  lifetime.cancel();
  const target = destination === 'passage' ? `highlight-${note.id}` : `margin-note-${note.id}`;
  const cancel = revealMarginTarget(root, scroll, target, reducedMotion !== false, () => {
    if (lifetime.isCurrent()) done();
  });
  if (cancel == null || !lifetime.isCurrent()) {
    cancel?.();
    return false;
  }
  lifetime.retain(cancel);
  bindings.onSelected(note.id);
  return true;
}

function useMarginNavigator({
  enabled = true,
  body,
  notes,
  quotes,
  pageRef,
  scrollRef,
}: Omit<Props, 'children'>): MarginNavigation {
  const reducedMotion = useReducedMotionSetting();
  const identity = useMemo(
    () => ({ body, notes, quotes, enabled }),
    [body, notes, quotes, enabled],
  );
  const lifetime = useNavigationLifetime(identity);
  const [selection, setSelection] = useState<{ identity: object; id: number } | null>(null);
  const drawn = useMemo(() => drawnNoteIds(body, notes, quotes), [body, notes, quotes]);
  const canNavigate = (note: Marginalia): boolean =>
    lifetime.isCurrent() &&
    enabled &&
    Platform.OS === 'web' &&
    noteNavigationAllowed(note, body, notes, drawn);
  const bindings: NavigationBindings = {
    pageRef,
    scrollRef,
    lifetime,
    reducedMotion,
    canNavigate,
    onSelected: (id) => setSelection({ identity, id }),
  };
  const reveal = (note: Marginalia, destination: 'passage' | 'note', done: () => void): boolean =>
    revealOnPage(bindings, note, destination, done);
  const value: MarginNavigation = {
    selectedId: selection?.identity === identity ? selection.id : null,
    isCurrent: lifetime.isCurrent,
    canNavigate,
    isStale: (note) => noteAnchorStale(note, body),
    fromPassage: (note, open) => {
      if (!lifetime.isCurrent() || !notes.includes(note)) return;
      if (!reveal(note, 'note', () => open(note)) && lifetime.isCurrent()) open(note);
    },
    fromNote: (note) => reveal(note, 'passage', () => {}),
  };
  return value;
}
export function MarginNavigationProvider({
  children,
  enabled = true,
  ...props
}: Props): React.JSX.Element {
  const value = useMarginNavigator({ ...props, enabled });
  return (
    <Context.Provider value={Platform.OS === 'web' && enabled ? value : null}>
      {children}
    </Context.Provider>
  );
}
