import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  botmason as botmasonApi,
  journal as journalApi,
  prompts as promptsApi,
  type JournalMessage,
  type PromptDetail,
  ApiError,
} from '../../api';
import { useAppRoute } from '../../navigation/hooks';

import ChatInput, { type MessageTags } from './ChatInput';
import styles from './Journal.styles';
import MessageBubble from './MessageBubble';
import SearchBar from './SearchBar';
import TagFilter, { type JournalTag } from './TagFilter';
import WeeklyPromptBanner from './WeeklyPromptBanner';

const PAGE_SIZE = 50;

// --- Sub-components ---

// --- Balance banner ---

const BalanceBanner = ({ balance }: { balance: number | null }): React.JSX.Element | null => {
  if (balance !== null && balance <= 0) {
    return (
      <View testID="balance-empty-banner" style={styles.balanceBanner}>
        <Text style={styles.balanceBannerText}>
          BotMason is resting. You can still write freeform reflections.
        </Text>
      </View>
    );
  }
  if (balance !== null && balance > 0) {
    return (
      <View testID="balance-counter" style={styles.balanceCounter}>
        <Text style={styles.balanceCounterText}>Offerings: {balance}</Text>
      </View>
    );
  }
  return null;
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
    <BalanceBanner balance={props.offeringBalance} />
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
  prev: JournalMessage[],
  optimisticId: number,
  created: JournalMessage,
): JournalMessage[] {
  return prev.map((m) => (m.id === optimisticId ? created : m));
}

function removeMessageById(prev: JournalMessage[], optimisticId: number): JournalMessage[] {
  return prev.filter((m) => m.id !== optimisticId);
}

// --- Hook: message list state ---

function useMessageList() {
  const [messages, setMessages] = useState<JournalMessage[]>([]);
  const [hasMore, setHasMore] = useState(false);

  const replaceOptimistic = useCallback((optimisticId: number, created: JournalMessage) => {
    setMessages((prev) => replaceMessageById(prev, optimisticId, created));
  }, []);

  const removeOptimistic = useCallback((optimisticId: number) => {
    setMessages((prev) => removeMessageById(prev, optimisticId));
  }, []);

  const prependMessage = useCallback((msg: JournalMessage) => {
    setMessages((prev) => [msg, ...prev]);
  }, []);

  return {
    messages,
    setMessages,
    hasMore,
    setHasMore,
    replaceOptimistic,
    removeOptimistic,
    prependMessage,
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

  const loadPrompt = useCallback(async () => {
    try {
      const detail = await promptsApi.current();
      if (!detail.has_responded) setPrompt(detail);
    } catch {
      // non-critical
    }
  }, []);

  const loadBalance = useCallback(async () => {
    try {
      const result = await botmasonApi.getBalance();
      setOfferingBalance(result.balance);
    } catch {
      // non-critical
    }
  }, []);

  return { prompt, setPrompt, offeringBalance, setOfferingBalance, loadPrompt, loadBalance };
}

// --- Hook: send freeform message ---

function useFreeformSend(
  practiceSessionId: number | null,
  userPracticeId: number | null,
  replaceOptimistic: (_id: number, _msg: JournalMessage) => void,
  removeOptimistic: (_id: number) => void,
) {
  return useCallback(
    async (text: string, mergedTags: MessageTags, optimisticId: number) => {
      try {
        const created = await journalApi.create({
          message: text,
          ...mergedTags,
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

function useBotSend(
  loadMessages: (_offset?: number) => Promise<void>,
  setOfferingBalance: (_b: number) => void,
  removeOptimistic: (_id: number) => void,
  sendFreeform: (_text: string, _tags: MessageTags, _id: number) => Promise<void>,
) {
  const [awaitingBot, setAwaitingBot] = useState(false);

  const sendWithBot = useCallback(
    async (text: string, mergedTags: MessageTags, optimisticId: number) => {
      try {
        setAwaitingBot(true);
        const chatResult = await botmasonApi.chat({ message: text });
        await loadMessages(0);
        setOfferingBalance(chatResult.remaining_balance);
      } catch (err) {
        if (err instanceof ApiError && err.status === 402) {
          setOfferingBalance(0);
          await sendFreeform(text, mergedTags, optimisticId);
        } else {
          console.error('BotMason chat failed:', err);
          removeOptimistic(optimisticId);
        }
      } finally {
        setAwaitingBot(false);
      }
    },
    [loadMessages, setOfferingBalance, removeOptimistic, sendFreeform],
  );

  return { awaitingBot, sendWithBot };
}

// --- Pure helpers ---

function buildMergedTags(
  tags: MessageTags | undefined,
  isCourseReflection: boolean,
  isPracticeReflection: boolean,
): MessageTags {
  return {
    is_stage_reflection: isCourseReflection || (tags?.is_stage_reflection ?? false),
    is_practice_note: isPracticeReflection || (tags?.is_practice_note ?? false),
    is_habit_note: tags?.is_habit_note ?? false,
  };
}

function buildOptimisticMessage(
  text: string,
  mergedTags: MessageTags,
  practiceSessionId: number | null,
  userPracticeId: number | null,
): JournalMessage {
  return {
    id: -Date.now(),
    message: text,
    sender: 'user',
    user_id: 0,
    timestamp: new Date().toISOString(),
    is_stage_reflection: mergedTags.is_stage_reflection,
    is_practice_note: mergedTags.is_practice_note,
    is_habit_note: mergedTags.is_habit_note,
    practice_session_id: practiceSessionId,
    user_practice_id: userPracticeId,
  };
}

// --- List helpers ---

const renderMessage = ({ item }: { item: JournalMessage }): React.JSX.Element => (
  <MessageBubble message={item} />
);

const keyExtractor = (item: JournalMessage): string => String(item.id);

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
  messages: JournalMessage[];
  loadingMore: boolean;
  loading: boolean;
  isFiltering: boolean;
  onLoadMore: () => void;
}

const JournalMessageList = ({
  messages,
  loadingMore,
  loading,
  isFiltering,
  onLoadMore,
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

  return (
    <FlatList
      testID="message-list"
      data={messages}
      renderItem={renderMessage}
      keyExtractor={keyExtractor}
      inverted
      contentContainerStyle={[styles.messageList, messages.length === 0 && { flexGrow: 1 }]}
      ListFooterComponent={renderFooter}
      ListEmptyComponent={renderEmpty}
      onEndReached={onLoadMore}
      onEndReachedThreshold={0.3}
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
};

function extractFromParams(p: JournalParams): JournalRouteParams {
  const practiceSessionId = p.practiceSessionId ?? null;
  const contentTitle = p.contentTitle ?? null;

  return {
    practiceSessionId,
    userPracticeId: p.userPracticeId ?? null,
    practiceName: p.practiceName ?? null,
    practiceDuration: p.practiceDuration ?? null,
    isPracticeReflection: practiceSessionId !== null,
    isCourseReflection: (p.stageReflection ?? false) && contentTitle !== null,
    stageNumber: p.stageNumber ?? null,
    contentTitle,
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
  loadBalance: () => Promise<void>,
) {
  useEffect(() => {
    const init = async () => {
      setLoading(true);
      await Promise.all([loadMessages(0), loadPrompt(), loadBalance()]);
      setLoading(false);
    };
    void init();
  }, [loadMessages, loadPrompt, loadBalance, setLoading]);
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
  prependMessage: (_msg: JournalMessage) => void,
  sendWithBot: (_text: string, _tags: MessageTags, _id: number) => Promise<void>,
  sendFreeform: (_text: string, _tags: MessageTags, _id: number) => Promise<void>,
) {
  const [sending, setSending] = useState(false);

  const handleSend = useCallback(
    async (text: string, tags?: MessageTags) => {
      setSending(true);
      const mergedTags = buildMergedTags(tags, rp.isCourseReflection, rp.isPracticeReflection);
      const optimistic = buildOptimisticMessage(
        text,
        mergedTags,
        rp.practiceSessionId,
        rp.userPracticeId,
      );
      prependMessage(optimistic);
      const hasBalance = offeringBalance !== null && offeringBalance > 0;
      if (hasBalance) {
        await sendWithBot(text, mergedTags, optimistic.id);
      } else {
        await sendFreeform(text, mergedTags, optimistic.id);
      }
      setSending(false);
    },
    [offeringBalance, rp, prependMessage, sendWithBot, sendFreeform],
  );

  return { sending, setSending, handleSend };
}

// --- Hook: compose all journal hooks ---

function useJournalComposer(
  searchQuery: string,
  activeTag: JournalTag | null,
  isFiltering: boolean,
  rp: JournalRouteParams,
) {
  const msgList = useMessageList();
  const loader = useMessageLoader(searchQuery, activeTag, isFiltering, msgList);
  const side = useJournalSideData();
  const { prependMessage, replaceOptimistic, removeOptimistic } = msgList;

  const sendFreeform = useFreeformSend(
    rp.practiceSessionId,
    rp.userPracticeId,
    replaceOptimistic,
    removeOptimistic,
  );
  const { awaitingBot, sendWithBot } = useBotSend(
    loader.loadMessages,
    side.setOfferingBalance,
    removeOptimistic,
    sendFreeform,
  );

  const { sending, setSending, handleSend } = useJournalSend(
    rp,
    side.offeringBalance,
    prependMessage,
    sendWithBot,
    sendFreeform,
  );

  useJournalInit(loader.loadMessages, loader.setLoading, side.loadPrompt, side.loadBalance);
  const handlePromptRespond = usePromptResponder(
    side.prompt,
    side.setPrompt,
    loader.loadMessages,
    setSending,
  );

  return { msgList, loader, side, awaitingBot, sending, handleSend, handlePromptRespond };
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

const PRACTICE_INITIAL_TAGS: MessageTags = {
  is_stage_reflection: false,
  is_practice_note: true,
  is_habit_note: false,
};

const COURSE_INITIAL_TAGS: MessageTags = {
  is_stage_reflection: true,
  is_practice_note: false,
  is_habit_note: false,
};

// --- Helper: resolve initial tags ---

function resolveInitialTags(rp: JournalRouteParams): MessageTags | undefined {
  if (rp.isCourseReflection) return COURSE_INITIAL_TAGS;
  if (rp.isPracticeReflection) return PRACTICE_INITIAL_TAGS;
  return undefined;
}

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
      />
      <TypingIndicator visible={j.awaitingBot} />
      <ChatInput onSend={j.handleSend} disabled={j.sending} initialTags={resolveInitialTags(rp)} />
    </SafeAreaView>
  );
};

export default JournalScreen;
