import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

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
  optimisticId: number,
  created: ChatMessage,
): ChatMessage[] {
  return prev.map((m) => (m.id === optimisticId ? created : m));
}

function removeMessageById(prev: ChatMessage[], optimisticId: number): ChatMessage[] {
  return prev.filter((m) => m.id !== optimisticId);
}

function appendStreamingChunk(prev: ChatMessage[], botId: number, chunk: string): ChatMessage[] {
  return prev.map((m) => (m.id === botId ? { ...m, message: m.message + chunk } : m));
}

function markMessageErrored(
  prev: ChatMessage[],
  userId: number,
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

function clearMessageError(prev: ChatMessage[], userId: number): ChatMessage[] {
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

  const replaceOptimistic = useCallback((optimisticId: number, created: ChatMessage) => {
    setMessages((prev) => replaceMessageById(prev, optimisticId, created));
  }, []);

  const removeOptimistic = useCallback((optimisticId: number) => {
    setMessages((prev) => removeMessageById(prev, optimisticId));
  }, []);

  const prependMessage = useCallback((msg: ChatMessage) => {
    setMessages((prev) => [msg, ...prev]);
  }, []);

  const appendChunk = useCallback((botId: number, chunk: string) => {
    setMessages((prev) => appendStreamingChunk(prev, botId, chunk));
  }, []);

  const markErrored = useCallback(
    (userId: number, retryText: string, retryTag: JournalTag, detail: string) => {
      setMessages((prev) => markMessageErrored(prev, userId, retryText, retryTag, detail));
    },
    [],
  );

  const clearError = useCallback((userId: number) => {
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

// --- Hook: send freeform message ---

function useFreeformSend(
  practiceSessionId: number | null,
  userPracticeId: number | null,
  replaceOptimistic: (_id: number, _msg: ChatMessage) => void,
  removeOptimistic: (_id: number) => void,
) {
  return useCallback(
    async (text: string, tag: JournalTag, optimisticId: number) => {
      try {
        const created = await journalApi.create({
          message: text,
          tag,
          practice_session_id: practiceSessionId,
          user_practice_id: userPracticeId,
        });
        replaceOptimistic(optimisticId, created);
      } catch (err) {
        console.error('Failed to send message:', err);
        removeOptimistic(optimisticId);
      }
    },
    [practiceSessionId, userPracticeId, replaceOptimistic, removeOptimistic],
  );
}

// --- Hook: send with bot ---

function createBotPlaceholder(): ChatMessage {
  // Offset by 1ms so the bot and user placeholders never collide on fast
  // hardware where ``Date.now()`` could return the same value back-to-back.
  return {
    id: -(Date.now() + 1),
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
  replaceOptimistic: (_id: number, _msg: ChatMessage) => void;
  removeOptimistic: (_id: number) => void;
  appendChunk: (_botId: number, _chunk: string) => void;
  markErrored: (_userId: number, _text: string, _tag: JournalTag, _detail: string) => void;
};

type BotSendDeps = {
  actions: ChatMessageListActions;
  setOfferingBalance: (_b: number) => void;
  setRemainingMessages: (_n: number) => void;
  sendFreeform: (_text: string, _tag: JournalTag, _id: number) => Promise<void>;
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
  optimisticUserId: number,
  botPlaceholderId: number,
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
  botPlaceholderId: number,
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
  optimisticUserId: number,
  botPlaceholderId: number,
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
  deps.actions.markErrored(optimisticUserId, text, tag, classifyError(err));
}

function useBotSend(deps: BotSendDeps) {
  // ``awaitingBot`` surfaces the "BotMason is thinking..." indicator only
  // while we are waiting for the first token. Once chunks start arriving the
  // bot placeholder itself communicates progress, so the standalone indicator
  // hides to avoid double-signalling.
  const [awaitingBot, setAwaitingBot] = useState(false);

  const sendWithBot = useCallback(
    async (text: string, tag: JournalTag, optimisticUserId: number) => {
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
  return {
    id: -Date.now(),
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
  sendWithBot: (_text: string, _tag: JournalTag, _id: number) => Promise<void>,
  sendFreeform: (_text: string, _tag: JournalTag, _id: number) => Promise<void>,
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
  clearError: (_id: number) => void,
  sendWithBot: (_t: string, _tag: JournalTag, _id: number) => Promise<void>,
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
  sendFreeform: (_t: string, _tag: JournalTag, _id: number) => Promise<void>,
) {
  return useBotSend({
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
  });
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
