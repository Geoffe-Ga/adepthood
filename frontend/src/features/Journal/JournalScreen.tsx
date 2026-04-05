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

import ChatInput, { type MessageTags } from './ChatInput';
import styles from './Journal.styles';
import MessageBubble from './MessageBubble';
import SearchBar from './SearchBar';
import TagFilter, { type JournalTag } from './TagFilter';
import WeeklyPromptBanner from './WeeklyPromptBanner';

const PAGE_SIZE = 50;

const JournalScreen = (): React.JSX.Element => {
  const [messages, setMessages] = useState<JournalMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [sending, setSending] = useState(false);
  const [prompt, setPrompt] = useState<PromptDetail | null>(null);
  const [offeringBalance, setOfferingBalance] = useState<number | null>(null);
  const [awaitingBot, setAwaitingBot] = useState(false);

  // Search and filter state
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTag, setActiveTag] = useState<JournalTag | null>(null);
  const [searchResultCount, setSearchResultCount] = useState<number | undefined>(undefined);
  const isFiltering = searchQuery.length > 0 || activeTag !== null;

  const loadMessages = useCallback(
    async (offset = 0) => {
      try {
        const params: Parameters<typeof journalApi.list>[0] = {
          limit: PAGE_SIZE,
          offset,
        };
        if (searchQuery) params.search = searchQuery;
        if (activeTag) params.tag = activeTag;

        const result = await journalApi.list(params);
        if (offset === 0) {
          setMessages(result.items);
          if (isFiltering) {
            setSearchResultCount(result.total);
          } else {
            setSearchResultCount(undefined);
          }
        } else {
          setMessages((prev) => [...prev, ...result.items]);
        }
        setHasMore(result.has_more);
      } catch (err) {
        console.error('Failed to load journal messages:', err);
      }
    },
    [searchQuery, activeTag, isFiltering],
  );

  const loadPrompt = useCallback(async () => {
    try {
      const detail = await promptsApi.current();
      if (!detail.has_responded) {
        setPrompt(detail);
      }
    } catch {
      // Prompt fetch is non-critical
    }
  }, []);

  const loadBalance = useCallback(async () => {
    try {
      const result = await botmasonApi.getBalance();
      setOfferingBalance(result.balance);
    } catch {
      // Balance fetch is non-critical; default to null (unknown)
    }
  }, []);

  useEffect(() => {
    const init = async () => {
      setLoading(true);
      await Promise.all([loadMessages(0), loadPrompt(), loadBalance()]);
      setLoading(false);
    };
    void init();
  }, [loadMessages, loadPrompt, loadBalance]);

  const handleLoadMore = useCallback(async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    await loadMessages(messages.length);
    setLoadingMore(false);
  }, [loadingMore, hasMore, messages.length, loadMessages]);

  const handleSend = useCallback(
    async (text: string, tags?: MessageTags) => {
      setSending(true);

      // Optimistic update — add a temporary user message immediately
      const optimistic: JournalMessage = {
        id: -Date.now(),
        message: text,
        sender: 'user',
        user_id: 0,
        timestamp: new Date().toISOString(),
        is_stage_reflection: tags?.is_stage_reflection ?? false,
        is_practice_note: tags?.is_practice_note ?? false,
        is_habit_note: tags?.is_habit_note ?? false,
        practice_session_id: null,
        user_practice_id: null,
      };
      setMessages((prev) => [optimistic, ...prev]);

      const hasBalance = offeringBalance !== null && offeringBalance > 0;

      if (hasBalance) {
        // Use BotMason AI chat endpoint
        try {
          setAwaitingBot(true);
          const chatResult = await botmasonApi.chat({ message: text });

          // Replace optimistic message with real messages from journal
          await loadMessages(0);
          setOfferingBalance(chatResult.remaining_balance);
        } catch (err) {
          if (err instanceof ApiError && err.status === 402) {
            // Balance ran out between check and request — fall back to freeform
            setOfferingBalance(0);
            try {
              const created = await journalApi.create({
                message: text,
                ...(tags ?? {}),
              });
              setMessages((prev) => prev.map((m) => (m.id === optimistic.id ? created : m)));
            } catch (createErr) {
              console.error('Failed to send freeform message:', createErr);
              setMessages((prev) => prev.filter((m) => m.id !== optimistic.id));
            }
          } else {
            console.error('BotMason chat failed:', err);
            setMessages((prev) => prev.filter((m) => m.id !== optimistic.id));
          }
        } finally {
          setAwaitingBot(false);
        }
      } else {
        // Freeform journaling (no AI)
        try {
          const created = await journalApi.create({
            message: text,
            ...(tags ?? {}),
          });
          setMessages((prev) => prev.map((m) => (m.id === optimistic.id ? created : m)));
        } catch (err) {
          console.error('Failed to send message:', err);
          setMessages((prev) => prev.filter((m) => m.id !== optimistic.id));
        }
      }

      setSending(false);
    },
    [offeringBalance, loadMessages],
  );

  const handlePromptRespond = useCallback(() => {
    if (!prompt) return;
    const sendPromptResponse = async () => {
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
    void sendPromptResponse();
  }, [prompt, loadMessages]);

  const handleSearch = useCallback((query: string) => {
    setSearchQuery(query);
  }, []);

  const handleSelectTag = useCallback((tag: JournalTag | null) => {
    setActiveTag(tag);
  }, []);

  const renderMessage = useCallback(
    ({ item }: { item: JournalMessage }) => <MessageBubble message={item} />,
    [],
  );

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
  }, [loading, isFiltering]);

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
          <ActivityIndicator testID="journal-loading" size="large" />
        </View>
      </SafeAreaView>
    );
  }

  const balanceIsZero = offeringBalance !== null && offeringBalance <= 0;

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <SearchBar
        onSearch={handleSearch}
        resultCount={searchResultCount}
        searchQuery={searchQuery}
      />
      <TagFilter activeTag={activeTag} onSelectTag={handleSelectTag} />
      {prompt && !isFiltering && (
        <WeeklyPromptBanner prompt={prompt} onRespond={handlePromptRespond} />
      )}
      {balanceIsZero && (
        <View testID="balance-empty-banner" style={styles.balanceBanner}>
          <Text style={styles.balanceBannerText}>
            BotMason is resting. You can still write freeform reflections.
          </Text>
        </View>
      )}
      {offeringBalance !== null && offeringBalance > 0 && (
        <View testID="balance-counter" style={styles.balanceCounter}>
          <Text style={styles.balanceCounterText}>Offerings: {offeringBalance}</Text>
        </View>
      )}
      <FlatList
        testID="message-list"
        data={messages}
        renderItem={renderMessage}
        keyExtractor={(item) => String(item.id)}
        inverted
        contentContainerStyle={[styles.messageList, messages.length === 0 && { flexGrow: 1 }]}
        ListFooterComponent={renderFooter}
        ListEmptyComponent={renderEmpty}
        onEndReached={handleLoadMore}
        onEndReachedThreshold={0.3}
      />
      {awaitingBot && (
        <View testID="typing-indicator" style={styles.typingIndicator}>
          <Text style={styles.typingIndicatorText}>BotMason is typing...</Text>
        </View>
      )}
      <ChatInput onSend={handleSend} disabled={sending} />
    </SafeAreaView>
  );
};

export default JournalScreen;
