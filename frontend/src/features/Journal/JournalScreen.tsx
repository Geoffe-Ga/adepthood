import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { v4 as uuidv4 } from 'uuid';

import {
  botmason as botmasonApi,
  journal as journalApi,
  prompts as promptsApi,
  type ChatResponse,
  type JournalTag,
  type PromptDetail,
  ApiError,
  StreamingUnsupportedError,
} from '../../api';
import { mapDetailToMessage } from '../../api/errorMessages';
import { useOptimisticMutation } from '../../hooks/useOptimisticMutation';
import { useAppRoute } from '../../navigation/hooks';

import ChatInput from './ChatInput';
import styles from './Journal.styles';
import MessageBubble, { type ChatMessage } from './MessageBubble';
import SearchBar from './SearchBar';
import TagFilter from './TagFilter';
import WeeklyPromptBanner from './WeeklyPromptBanner';

const PAGE_SIZE = 50;

// Translating the server's ``detail`` field to user copy is the job of the
// shared mapper in ``api/errorMessages``. We keep a thin alias here to
// avoid churn in call sites that historically used ``mapErrorMessage``.
const mapErrorMessage = mapDetailToMessage;

// --- Sub-components ---

// --- Balance banner ---

interface BalanceBannerProps {
  balance: number | null;
  remainingMessages: number | null;
}

const BalanceBanner = ({
  balance,
  remainingMessages,
}: BalanceBannerProps): React.JSX.Element | null => {
  // Until the first fetch completes we render nothing — showing "resting"
  // prematurely would confuse users whose wallet is actually healthy.
  if (balance === null || remainingMessages === null) {
    return null;
  }
  if (remainingMessages > 0) {
    const offeringsNote = balance > 0 ? ` \u2022 ${balance} offerings` : '';
    return (
      <View testID="balance-counter" style={styles.balanceCounter}>
        <Text style={styles.balanceCounterText}>
          {remainingMessages} free BotMason messages left this month{offeringsNote}
        </Text>
      </View>
    );
  }
  if (balance > 0) {
    return (
      <View testID="balance-counter" style={styles.balanceCounter}>
        <Text style={styles.balanceCounterText}>
          {`Monthly cap reached \u2014 ${balance} offerings available`}
        </Text>
      </View>
    );
  }
  return (
    <View testID="balance-empty-banner" style={styles.balanceBanner}>
      <Text style={styles.balanceBannerText}>
        BotMason is resting until the cap resets. You can still write freeform reflections.
      </Text>
    </View>
  );
};

// --- Context banners ---

interface ContextBannerProps {
  isCourseReflection: boolean;
  contentTitle: string | null;
  stageNumber: number | null;
  isPracticeReflection: boolean;
  practiceName: string | null;
  practiceDuration: number | null;
}

const ContextBanners = (props: ContextBannerProps): React.JSX.Element => (
  <>
    {props.isCourseReflection && (
      <View testID="course-reflection-header" style={styles.balanceBanner}>
        <Text style={styles.balanceBannerText}>
          Reflecting on: {props.contentTitle}
          {props.stageNumber !== null ? ` \u2014 Stage ${props.stageNumber}` : ''}
        </Text>
      </View>
    )}
    {props.isPracticeReflection && (
      <View testID="practice-reflection-header" style={styles.balanceBanner}>
        <Text style={styles.balanceBannerText}>
          Reflection on {props.practiceName}
          {props.practiceDuration !== null ? ` \u2014 ${props.practiceDuration} minutes` : ''}
        </Text>
      </View>
    )}
  </>
);

interface BannersProps {
  prompt: PromptDetail | null;
  isFiltering: boolean;
  onPromptRespond: () => void;
  offeringBalance: number | null;
  remainingMessages: number | null;
  isCourseReflection: boolean;
  contentTitle: string | null;
  stageNumber: number | null;
  isPracticeReflection: boolean;
  practiceName: string | null;
  practiceDuration: number | null;
}

const JournalBanners = (props: BannersProps): React.JSX.Element => (
  <>
    {props.prompt && !props.isFiltering && (
      <WeeklyPromptBanner prompt={props.prompt} onRespond={props.onPromptRespond} />
    )}
    <BalanceBanner balance={props.offeringBalance} remainingMessages={props.remainingMessages} />
    <ContextBanners
      isCourseReflection={props.isCourseReflection}
      contentTitle={props.contentTitle}
      stageNumber={props.stageNumber}
      isPracticeReflection={props.isPracticeReflection}
      practiceName={props.practiceName}
      practiceDuration={props.practiceDuration}
    />
  </>
);

// --- Message updater helpers ---

function replaceMessageById(
  prev: ChatMessage[],
  optimisticId: number | string,
  created: ChatMessage,
): ChatMessage[] {
  return prev.map((m) => (m.id === optimisticId ? created : m));
}

function removeMessageById(prev: ChatMessage[], optimisticId: number | string): ChatMessage[] {
  return prev.filter((m) => m.id !== optimisticId);
}

function appendStreamingChunk(
  prev: ChatMessage[],
  botId: number | string,
  chunk: string,
): ChatMessage[] {
  return prev.map((m) => (m.id === botId ? { ...m, message: m.message + chunk } : m));
}

function markMessageErrored(
  prev: ChatMessage[],
  userId: number | string,
  retryText: string,
  retryTag: JournalTag,
  detail: string,
): ChatMessage[] {
  return prev.map((m) =>
    m.id === userId
      ? { ...m, _errored: true, _errorDetail: detail, _retryText: retryText, _retryTag: retryTag }
      : m,
  );
}

function clearMessageError(prev: ChatMessage[], userId: number | string): ChatMessage[] {
  return prev.map((m) => {
    if (m.id !== userId) return m;
    // Strip the ephemeral error metadata but keep every wire field intact —
    // destructuring would force us to name the discarded keys, which eslint
    // then flags as unused.
    const next: ChatMessage = { ...m };
    delete next._errored;
    delete next._errorDetail;
    delete next._retryText;
    delete next._retryTag;
    return next;
  });
}

// --- Hook: message list state ---

function useMessageList() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [hasMore, setHasMore] = useState(false);

  const replaceOptimistic = useCallback((optimisticId: number | string, created: ChatMessage) => {
    setMessages((prev) => replaceMessageById(prev, optimisticId, created));
  }, []);

  const removeOptimistic = useCallback((optimisticId: number | string) => {
    setMessages((prev) => removeMessageById(prev, optimisticId));
  }, []);

  const prependMessage = useCallback((msg: ChatMessage) => {
    setMessages((prev) => [msg, ...prev]);
  }, []);

  const appendChunk = useCallback((botId: number | string, chunk: string) => {
    setMessages((prev) => appendStreamingChunk(prev, botId, chunk));
  }, []);

  const markErrored = useCallback(
    (userId: number | string, retryText: string, retryTag: JournalTag, detail: string) => {
      setMessages((prev) => markMessageErrored(prev, userId, retryText, retryTag, detail));
    },
    [],
  );

  const clearError = useCallback((userId: number | string) => {
    setMessages((prev) => clearMessageError(prev, userId));
  }, []);

  return {
    messages,
    setMessages,
    hasMore,
    setHasMore,
    replaceOptimistic,
    removeOptimistic,
    prependMessage,
    appendChunk,
    markErrored,
    clearError,
  };
}

// --- Hook: message loading ---

function useMessageLoader(
  searchQuery: string,
  activeTag: JournalTag | null,
  isFiltering: boolean,
  msgList: ReturnType<typeof useMessageList>,
) {
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [searchResultCount, setSearchResultCount] = useState<number | undefined>(undefined);
  const { setMessages, setHasMore, hasMore, messages } = msgList;

  const loadMessages = useCallback(
    async (offset = 0) => {
      try {
        const params: Parameters<typeof journalApi.list>[0] = { limit: PAGE_SIZE, offset };
        if (searchQuery) params.search = searchQuery;
        if (activeTag) params.tag = activeTag;
        const result = await journalApi.list(params);
        if (offset === 0) {
          setMessages(result.items);
          setSearchResultCount(isFiltering ? result.total : undefined);
        } else {
          setMessages((prev) => [...prev, ...result.items]);
        }
        setHasMore(result.has_more);
      } catch (err) {
        console.error('Failed to load journal messages:', err);
      }
    },
    [searchQuery, activeTag, isFiltering, setMessages, setHasMore],
  );

  const handleLoadMore = useCallback(async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    await loadMessages(messages.length);
    setLoadingMore(false);
  }, [loadingMore, hasMore, messages.length, loadMessages]);

  return { loading, setLoading, loadingMore, searchResultCount, loadMessages, handleLoadMore };
}

// --- Hook: prompt & balance ---

function useJournalSideData() {
  const [prompt, setPrompt] = useState<PromptDetail | null>(null);
  const [offeringBalance, setOfferingBalance] = useState<number | null>(null);
  const [remainingMessages, setRemainingMessages] = useState<number | null>(null);

  const loadPrompt = useCallback(async () => {
    try {
      const detail = await promptsApi.current();
      if (!detail.has_responded) setPrompt(detail);
    } catch {
      // non-critical
    }
  }, []);

  // One round-trip now returns both wallets.  We still fetch on mount only;
  // subsequent chats update the counters via the ChatResponse fields so the
  // UI stays in sync without polling.
  const loadUsage = useCallback(async () => {
    try {
      const result = await botmasonApi.getUsage();
      setOfferingBalance(result.offering_balance);
      setRemainingMessages(result.monthly_messages_remaining);
    } catch {
      // non-critical — keep nulls so the banner stays hidden until a fetch succeeds
    }
  }, []);

  return {
    prompt,
    setPrompt,
    offeringBalance,
    setOfferingBalance,
    remainingMessages,
    setRemainingMessages,
    loadPrompt,
    loadUsage,
  };
}

// --- Hook: send freeform message (migrated to useOptimisticMutation) ---

interface FreeformSendInput {
  text: string;
  tag: JournalTag;
  optimisticId: number | string;
}

function useFreeformSend(
  practiceSessionId: number | null,
  userPracticeId: number | null,
  replaceOptimistic: (_id: number | string, _msg: ChatMessage) => void,
  removeOptimistic: (_id: number | string) => void,
) {
  // CONTRACT NOTE: `useOptimisticMutation`'s docblock says `apply` is
  // the only path that mutates the store before the network call. We
  // intentionally violate that here: the optimistic bubble is
  // prepended at the call site (`useJournalSend.handleSend` →
  // `prependMessage(buildOptimisticMessage(...))`) so the bot-send
  // path can hand the SAME bubble to either `sendWithBot` or this
  // freeform fallback without double-prepending. `apply` is therefore
  // a no-op; `rollback`'s `removeOptimistic` operates on state that
  // was mutated outside this hook's lifecycle. If `useFreeformSend` is
  // ever called from a context other than `handleSend`, that caller
  // must also pre-prepend the bubble.
  const mutation = useOptimisticMutation<FreeformSendInput, void>({
    apply: () => {
      /* no-op: bubble is prepended by handleSend; see CONTRACT NOTE above */
    },
    commit: async ({ text, tag, optimisticId }) => {
      const created = await journalApi.create({
        message: text,
        tag,
        practice_session_id: practiceSessionId,
        user_practice_id: userPracticeId,
      });
      // Reconcile the optimistic bubble with the server-issued id on
      // success. We do this here (inside `commit`) because the result
      // is the message itself — calling replaceOptimistic from the
      // commit's resolved value keeps the success path one place.
      replaceOptimistic(optimisticId, created);
    },
    rollback: ({ optimisticId }, err) => {
      // Drop the un-persistable bubble from the list. Logging is left
      // to the caller; the hook re-throws the original error so the
      // bot-error path can decide whether to show a retry toast.
      console.error('Failed to send message:', err);
      removeOptimistic(optimisticId);
    },
  });

  return useCallback(
    async (text: string, tag: JournalTag, optimisticId: number | string): Promise<void> => {
      try {
        await mutation.mutate({ text, tag, optimisticId });
      } catch {
        // Already rolled back; swallow so bot-send fallback callers
        // don't see a spurious second rejection.
      }
    },
    [mutation],
  );
}

// --- Hook: send with bot ---

function createBotPlaceholder(): ChatMessage {
  // BUG-FE-JOURNAL-003: ``Date.now()`` returns a `number` that collides
  // when two placeholders allocate within the same millisecond — a real
  // case when a user double-taps Retry. UUIDs are collision-free across
  // the lifetime of the screen and prevent FlatList "two children with
  // the same key" warnings even under rapid retry traffic.
  return {
    id: `bot-${uuidv4()}`,
    message: '',
    sender: 'bot',
    timestamp: new Date().toISOString(),
    tag: 'freeform',
    practice_session_id: null,
    user_practice_id: null,
    _streaming: true,
  };
}

function buildFinalBotMessage(placeholder: ChatMessage, result: ChatResponse): ChatMessage {
  return {
    ...placeholder,
    id: result.bot_entry_id,
    message: result.response,
    timestamp: new Date().toISOString(),
    _streaming: false,
  };
}

type ChatMessageListActions = {
  prependMessage: (_msg: ChatMessage) => void;
  replaceOptimistic: (_id: number | string, _msg: ChatMessage) => void;
  removeOptimistic: (_id: number | string) => void;
  appendChunk: (_botId: number | string, _chunk: string) => void;
  markErrored: (_userId: number | string, _text: string, _tag: JournalTag, _detail: string) => void;
};

type BotSendDeps = {
  actions: ChatMessageListActions;
  setOfferingBalance: (_b: number) => void;
  setRemainingMessages: (_n: number) => void;
  sendFreeform: (_text: string, _tag: JournalTag, _id: number | string) => Promise<void>;
};

// Derive a stable error detail string from any thrown value so the retry UI
// has exactly one code path regardless of whether the problem was HTTP,
// mid-stream, or a dropped network socket.
function classifyError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 429) return 'rate_limit_exceeded';
    return err.detail;
  }
  return 'network_error';
}

async function sendWithNonStreamingFallback(
  text: string,
  tag: JournalTag,
  optimisticUserId: number | string,
  botPlaceholderId: number | string,
  deps: BotSendDeps,
): Promise<void> {
  // Used when the runtime fetch cannot expose a streaming body. We still
  // want the final response to land in the list, so we do a single round
  // trip and rewrite the placeholder once with the server's answer.
  try {
    const result = await botmasonApi.chat({ message: text });
    deps.actions.replaceOptimistic(
      botPlaceholderId,
      buildFinalBotMessage({ ...createBotPlaceholder(), id: botPlaceholderId }, result),
    );
    deps.setOfferingBalance(result.remaining_balance);
    deps.setRemainingMessages(result.remaining_messages);
  } catch (err) {
    deps.actions.removeOptimistic(botPlaceholderId);
    if (isInsufficientOfferingsError(err)) {
      deps.setOfferingBalance(0);
      deps.setRemainingMessages(0);
      await deps.sendFreeform(text, tag, optimisticUserId);
      return;
    }
    deps.actions.markErrored(optimisticUserId, text, tag, classifyError(err));
  }
}

type StreamOutcome = { completed: boolean; streamError: string | null };

async function runChatStream(
  text: string,
  botPlaceholderId: number | string,
  onFirstChunk: () => void,
  deps: BotSendDeps,
): Promise<StreamOutcome> {
  const outcome: StreamOutcome = { completed: false, streamError: null };
  let sawFirstChunk = false;
  await botmasonApi.chatStream(
    { message: text },
    {
      onChunk: (chunk) => {
        if (!sawFirstChunk) {
          sawFirstChunk = true;
          onFirstChunk();
        }
        deps.actions.appendChunk(botPlaceholderId, chunk);
      },
      onComplete: (result) => {
        outcome.completed = true;
        deps.actions.replaceOptimistic(
          botPlaceholderId,
          buildFinalBotMessage({ ...createBotPlaceholder(), id: botPlaceholderId }, result),
        );
        deps.setOfferingBalance(result.remaining_balance);
        deps.setRemainingMessages(result.remaining_messages);
      },
      onStreamError: (err) => {
        outcome.streamError = err.detail;
      },
    },
  );
  return outcome;
}

// 402 responses come in two flavours: both wallets drained
// (``insufficient_offerings`` — the legitimate "out of credit" path) and BYOK
// provider-side misconfiguration (``llm_key_required``). Only the former
// should downgrade to a freeform save; the latter is user-actionable and
// belongs in the retry UI.
function isInsufficientOfferingsError(err: unknown): err is ApiError {
  return err instanceof ApiError && err.status === 402 && err.detail === 'insufficient_offerings';
}

async function handleStreamError(
  err: unknown,
  text: string,
  tag: JournalTag,
  optimisticUserId: number | string,
  botPlaceholderId: number | string,
  deps: BotSendDeps,
): Promise<void> {
  deps.actions.removeOptimistic(botPlaceholderId);
  if (err instanceof StreamingUnsupportedError) {
    // Runtime cannot read the body progressively — retry via the legacy
    // request/response endpoint so the user still receives the reply, just
    // without the typewriter effect.
    const fallbackPlaceholder = createBotPlaceholder();
    deps.actions.prependMessage(fallbackPlaceholder);
    await sendWithNonStreamingFallback(text, tag, optimisticUserId, fallbackPlaceholder.id, deps);
    return;
  }
  if (isInsufficientOfferingsError(err)) {
    deps.setOfferingBalance(0);
    deps.setRemainingMessages(0);
    await deps.sendFreeform(text, tag, optimisticUserId);
    return;
  }
  // BUG-FE-JOURNAL-002: when the bot stream throws synchronously (auth,
  // DNS, 500) before any chunk arrives the chat service never persists
  // the user message server-side — so on next reload the user's words
  // simply vanish. We mark the bubble errored for the in-session retry
  // UX AND persist the message via the journal endpoint so a reload
  // recovers it. The persistence is fire-and-forget against a separate
  // journal row; if the user retries inline (via `_retryText`) and the
  // bot stream succeeds, the chat service writes its own user_entry —
  // a single duplicate is the lesser evil compared to silently losing
  // the user's text. (Server-side dedupe via idempotency key is tracked
  // in BUG-BM-012's follow-up.)
  deps.actions.markErrored(optimisticUserId, text, tag, classifyError(err));
  void persistUserMessageBackground(text, tag);
}

/**
 * Fire-and-forget write to the freeform journal endpoint so a stream
 * failure doesn't lose the user's words. We deliberately do not
 * reconcile the local errored bubble — the bubble stays in retry state
 * until either the user taps retry (which re-runs the bot stream) or
 * navigates away. On next mount, the server-persisted row appears and
 * the optimistic bubble is dropped by state reset.
 */
function persistUserMessageBackground(text: string, tag: JournalTag): Promise<void> {
  return journalApi
    .create({ message: text, tag, practice_session_id: null, user_practice_id: null })
    .then(() => undefined)
    .catch((err: unknown) => {
      // We tried; the user sees a retry button in-session anyway.
      console.error('Failed to persist user message after stream error:', err);
    });
}

function useBotSend(deps: BotSendDeps) {
  // ``awaitingBot`` surfaces the "BotMason is thinking..." indicator only
  // while we are waiting for the first token. Once chunks start arriving the
  // bot placeholder itself communicates progress, so the standalone indicator
  // hides to avoid double-signalling.
  const [awaitingBot, setAwaitingBot] = useState(false);

  const sendWithBot = useCallback(
    async (text: string, tag: JournalTag, optimisticUserId: number | string) => {
      const botPlaceholder = createBotPlaceholder();
      deps.actions.prependMessage(botPlaceholder);
      setAwaitingBot(true);
      try {
        const outcome = await runChatStream(
          text,
          botPlaceholder.id,
          () => setAwaitingBot(false),
          deps,
        );
        if (!outcome.completed) {
          // Stream closed early — either a provider error event arrived or
          // the socket dropped without a ``complete``. Either way we treat
          // it as a retryable failure.
          deps.actions.removeOptimistic(botPlaceholder.id);
          deps.actions.markErrored(
            optimisticUserId,
            text,
            tag,
            outcome.streamError ?? 'incomplete_stream',
          );
        }
      } catch (err) {
        await handleStreamError(err, text, tag, optimisticUserId, botPlaceholder.id, deps);
      } finally {
        setAwaitingBot(false);
      }
    },
    [deps],
  );

  return { awaitingBot, sendWithBot };
}

// --- Pure helpers ---

function resolveTag(
  userTag: JournalTag | undefined,
  contextTag: JournalTag | undefined,
): JournalTag {
  return contextTag ?? userTag ?? 'freeform';
}

function buildOptimisticMessage(
  text: string,
  tag: JournalTag,
  practiceSessionId: number | null,
  userPracticeId: number | null,
): ChatMessage {
  // BUG-FE-JOURNAL-003: UUID prevents id collisions between the user's
  // optimistic bubble and any concurrent bot placeholder, and between
  // sibling retries that fire within the same millisecond.
  return {
    id: `user-${uuidv4()}`,
    message: text,
    sender: 'user',
    timestamp: new Date().toISOString(),
    tag,
    practice_session_id: practiceSessionId,
    user_practice_id: userPracticeId,
  };
}

// --- List helpers ---

// BUG-FRONTEND-INFRA-014: explicit typing keeps the extractor in sync with
// the FlatList generic so a later rename/add on ChatMessage fails the type
// check instead of silently coercing to ``any`` through the default signature.
const keyExtractor: (_item: ChatMessage, _index: number) => string = (item) => String(item.id);

/**
 * BUG-FRONTEND-INFRA-015: FlatList gets dramatically faster when we can give
 * it a fixed item height — it skips synchronous measurement and can jump to
 * ``messages[i]`` in O(1). Messages have variable wrap but a sensible
 * average keeps scrollToEnd/scrollToIndex accurate enough for the inverted
 * layout we use here.
 */
const ESTIMATED_MESSAGE_HEIGHT = 84;
const journalGetItemLayout = (
  _data: ArrayLike<ChatMessage> | null | undefined,
  index: number,
): { length: number; offset: number; index: number } => ({
  length: ESTIMATED_MESSAGE_HEIGHT,
  offset: ESTIMATED_MESSAGE_HEIGHT * index,
  index,
});

function getErrorLabel(detail: string | undefined): string {
  if (!detail) return '';
  return mapErrorMessage(detail);
}

// --- Empty state ---

const EmptyState = ({ isFiltering }: { isFiltering: boolean }): React.JSX.Element => {
  if (isFiltering) {
    return (
      <View style={styles.emptyContainer}>
        <Text style={styles.emptyTitle}>No Results</Text>
        <Text style={styles.emptySubtitle}>
          No journal entries match your search. Try different keywords or filters.
        </Text>
      </View>
    );
  }
  return (
    <View style={styles.emptyContainer}>
      <Text style={styles.emptyIcon}>{'~'}</Text>
      <Text style={styles.emptyTitle}>Your Journal Awaits</Text>
      <Text style={styles.emptySubtitle}>
        Write your first reflection below. BotMason will be here to accompany your journey.
      </Text>
    </View>
  );
};

// --- Loading state ---

const JournalLoading = (): React.JSX.Element => (
  <SafeAreaView style={styles.container}>
    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
      <ActivityIndicator testID="journal-loading" size="large" />
    </View>
  </SafeAreaView>
);

// --- Message list sub-component ---

interface JournalMessageListProps {
  messages: ChatMessage[];
  loadingMore: boolean;
  loading: boolean;
  isFiltering: boolean;
  onLoadMore: () => void;
  onRetry: (_message: ChatMessage) => void;
}

const JournalMessageList = ({
  messages,
  loadingMore,
  loading,
  isFiltering,
  onLoadMore,
  onRetry,
}: JournalMessageListProps): React.JSX.Element => {
  const renderFooter = useCallback(() => {
    if (!loadingMore) return null;
    return (
      <View style={styles.loadingMore}>
        <ActivityIndicator size="small" />
      </View>
    );
  }, [loadingMore]);

  const renderEmpty = useCallback(() => {
    if (loading) return null;
    return <EmptyState isFiltering={isFiltering} />;
  }, [loading, isFiltering]);

  const renderItem = useCallback(
    ({ item }: { item: ChatMessage }) => (
      <MessageBubble
        message={item}
        errorLabel={getErrorLabel(item._errorDetail)}
        onRetry={item._errored ? () => onRetry(item) : undefined}
      />
    ),
    [onRetry],
  );

  return (
    <FlatList
      testID="message-list"
      data={messages}
      renderItem={renderItem}
      keyExtractor={keyExtractor}
      getItemLayout={journalGetItemLayout}
      inverted
      contentContainerStyle={[styles.messageList, messages.length === 0 && { flexGrow: 1 }]}
      ListFooterComponent={renderFooter}
      ListEmptyComponent={renderEmpty}
      onEndReached={onLoadMore}
      onEndReachedThreshold={0.3}
      removeClippedSubviews
      initialNumToRender={20}
      maxToRenderPerBatch={20}
      windowSize={11}
    />
  );
};

// --- Hook: route params ---

interface JournalRouteParams {
  practiceSessionId: number | null;
  userPracticeId: number | null;
  practiceName: string | null;
  practiceDuration: number | null;
  isPracticeReflection: boolean;
  isCourseReflection: boolean;
  stageNumber: number | null;
  contentTitle: string | null;
  contextTag: JournalTag | undefined;
}

type JournalParams = NonNullable<ReturnType<typeof useAppRoute<'Journal'>>['params']>;

const DEFAULT_ROUTE_PARAMS: JournalRouteParams = {
  practiceSessionId: null,
  userPracticeId: null,
  practiceName: null,
  practiceDuration: null,
  isPracticeReflection: false,
  isCourseReflection: false,
  stageNumber: null,
  contentTitle: null,
  contextTag: undefined,
};

function extractFromParams(p: JournalParams): JournalRouteParams {
  const practiceSessionId = p.practiceSessionId ?? null;
  const contentTitle = p.contentTitle ?? null;
  const tag = p.tag;

  const isCourseReflection = tag === 'stage_reflection' && contentTitle !== null;
  const isPracticeReflection = practiceSessionId !== null;

  return {
    practiceSessionId,
    userPracticeId: p.userPracticeId ?? null,
    practiceName: p.practiceName ?? null,
    practiceDuration: p.practiceDuration ?? null,
    isPracticeReflection,
    isCourseReflection,
    stageNumber: p.stageNumber ?? null,
    contentTitle,
    contextTag: tag,
  };
}

function useJournalRouteParams(): JournalRouteParams {
  const route = useAppRoute<'Journal'>();
  if (!route.params) return DEFAULT_ROUTE_PARAMS;
  return extractFromParams(route.params);
}

// --- Hook: init loading ---

function useJournalInit(
  loadMessages: (_offset?: number) => Promise<void>,
  setLoading: (_v: boolean) => void,
  loadPrompt: () => Promise<void>,
  loadUsage: () => Promise<void>,
) {
  useEffect(() => {
    const init = async () => {
      setLoading(true);
      await Promise.all([loadMessages(0), loadPrompt(), loadUsage()]);
      setLoading(false);
    };
    void init();
  }, [loadMessages, loadPrompt, loadUsage, setLoading]);
}

// --- Hook: prompt responding ---

function usePromptResponder(
  prompt: PromptDetail | null,
  setPrompt: (_p: PromptDetail | null) => void,
  loadMessages: (_offset?: number) => Promise<void>,
  setSending: (_v: boolean) => void,
) {
  return useCallback(() => {
    if (!prompt) return;
    const respond = async () => {
      setSending(true);
      try {
        await promptsApi.respond(prompt.week_number, prompt.question);
        setPrompt(null);
        await loadMessages(0);
      } catch (err) {
        console.error('Failed to respond to prompt:', err);
      } finally {
        setSending(false);
      }
    };
    void respond();
  }, [prompt, setPrompt, loadMessages, setSending]);
}

// --- Hook: compose send ---

function useJournalSend(
  rp: JournalRouteParams,
  offeringBalance: number | null,
  remainingMessages: number | null,
  prependMessage: (_msg: ChatMessage) => void,
  sendWithBot: (_text: string, _tag: JournalTag, _id: number | string) => Promise<void>,
  sendFreeform: (_text: string, _tag: JournalTag, _id: number | string) => Promise<void>,
) {
  const [sending, setSending] = useState(false);

  const handleSend = useCallback(
    async (text: string, userTag?: JournalTag) => {
      setSending(true);
      const tag = resolveTag(userTag, rp.contextTag);
      const optimistic = buildOptimisticMessage(text, tag, rp.practiceSessionId, rp.userPracticeId);
      prependMessage(optimistic);
      // BotMason is reachable as long as either wallet has capacity — the
      // backend drains the free monthly allocation first and then falls back
      // to offering_balance, so the UI only needs to know that at least one
      // bucket is non-empty before attempting the request.
      const hasFreeMessages = remainingMessages !== null && remainingMessages > 0;
      const hasOfferings = offeringBalance !== null && offeringBalance > 0;
      if (hasFreeMessages || hasOfferings) {
        await sendWithBot(text, tag, optimistic.id);
      } else {
        await sendFreeform(text, tag, optimistic.id);
      }
      setSending(false);
    },
    [offeringBalance, remainingMessages, rp, prependMessage, sendWithBot, sendFreeform],
  );

  return { sending, setSending, handleSend };
}

// --- Hook: compose all journal hooks ---

function useRetryHandler(
  clearError: (_id: number | string) => void,
  sendWithBot: (_t: string, _tag: JournalTag, _id: number | string) => Promise<void>,
) {
  // Retry resends the original text/tag without creating a new user message —
  // the existing errored message stays in place, its error flag is cleared,
  // and a fresh bot placeholder is prepended. No duplicate user entry even
  // if the user double-taps the retry button.
  return useCallback(
    async (message: ChatMessage) => {
      if (!message._retryText || !message._retryTag) return;
      const { _retryText, _retryTag } = message;
      clearError(message.id);
      await sendWithBot(_retryText, _retryTag, message.id);
    },
    [clearError, sendWithBot],
  );
}

function useBotSendWithActions(
  msgList: ReturnType<typeof useMessageList>,
  side: ReturnType<typeof useJournalSideData>,
  sendFreeform: (_t: string, _tag: JournalTag, _id: number | string) => Promise<void>,
) {
  // The individual callbacks coming out of `useMessageList` and
  // `useJournalSideData` are already stable `useCallback`s, but the
  // wrapper object literal here would be a new reference every render
  // — and `useBotSend`'s `sendWithBot` depends on it, so its identity
  // would change every render too. Memo'ing the deps bag keeps
  // downstream identities stable.
  const deps = useMemo(
    () => ({
      actions: {
        prependMessage: msgList.prependMessage,
        replaceOptimistic: msgList.replaceOptimistic,
        removeOptimistic: msgList.removeOptimistic,
        appendChunk: msgList.appendChunk,
        markErrored: msgList.markErrored,
      },
      setOfferingBalance: side.setOfferingBalance,
      setRemainingMessages: side.setRemainingMessages,
      sendFreeform,
    }),
    [
      msgList.prependMessage,
      msgList.replaceOptimistic,
      msgList.removeOptimistic,
      msgList.appendChunk,
      msgList.markErrored,
      side.setOfferingBalance,
      side.setRemainingMessages,
      sendFreeform,
    ],
  );
  return useBotSend(deps);
}

function useJournalComposer(
  searchQuery: string,
  activeTag: JournalTag | null,
  isFiltering: boolean,
  rp: JournalRouteParams,
) {
  const msgList = useMessageList();
  const loader = useMessageLoader(searchQuery, activeTag, isFiltering, msgList);
  const side = useJournalSideData();
  const sendFreeform = useFreeformSend(
    rp.practiceSessionId,
    rp.userPracticeId,
    msgList.replaceOptimistic,
    msgList.removeOptimistic,
  );
  const { awaitingBot, sendWithBot } = useBotSendWithActions(msgList, side, sendFreeform);

  const { sending, setSending, handleSend } = useJournalSend(
    rp,
    side.offeringBalance,
    side.remainingMessages,
    msgList.prependMessage,
    sendWithBot,
    sendFreeform,
  );

  useJournalInit(loader.loadMessages, loader.setLoading, side.loadPrompt, side.loadUsage);
  const handlePromptRespond = usePromptResponder(
    side.prompt,
    side.setPrompt,
    loader.loadMessages,
    setSending,
  );
  const handleRetry = useRetryHandler(msgList.clearError, sendWithBot);

  return {
    msgList,
    loader,
    side,
    awaitingBot,
    sending,
    handleSend,
    handlePromptRespond,
    handleRetry,
  };
}

// --- Typing indicator ---

const TypingIndicator = ({ visible }: { visible: boolean }): React.JSX.Element | null => {
  if (!visible) return null;
  return (
    <View testID="typing-indicator" style={styles.typingIndicator}>
      <Text style={styles.typingIndicatorText}>BotMason is typing...</Text>
    </View>
  );
};

// --- Main component ---

const JournalScreen = (): React.JSX.Element => {
  const rp = useJournalRouteParams();
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTag, setActiveTag] = useState<JournalTag | null>(null);
  const isFiltering = searchQuery.length > 0 || activeTag !== null;

  const j = useJournalComposer(searchQuery, activeTag, isFiltering, rp);

  if (j.loader.loading) return <JournalLoading />;

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <SearchBar
        onSearch={setSearchQuery}
        resultCount={j.loader.searchResultCount}
        searchQuery={searchQuery}
      />
      <TagFilter activeTag={activeTag} onSelectTag={setActiveTag} />
      <JournalBanners
        prompt={j.side.prompt}
        isFiltering={isFiltering}
        onPromptRespond={j.handlePromptRespond}
        offeringBalance={j.side.offeringBalance}
        remainingMessages={j.side.remainingMessages}
        isCourseReflection={rp.isCourseReflection}
        contentTitle={rp.contentTitle}
        stageNumber={rp.stageNumber}
        isPracticeReflection={rp.isPracticeReflection}
        practiceName={rp.practiceName}
        practiceDuration={rp.practiceDuration}
      />
      <JournalMessageList
        messages={j.msgList.messages}
        loadingMore={j.loader.loadingMore}
        loading={j.loader.loading}
        isFiltering={isFiltering}
        onLoadMore={j.loader.handleLoadMore}
        onRetry={j.handleRetry}
      />
      <TypingIndicator visible={j.awaitingBot} />
      <ChatInput onSend={j.handleSend} disabled={j.sending} initialTag={rp.contextTag} />
    </SafeAreaView>
  );
};

export default JournalScreen;
