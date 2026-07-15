import React from 'react';
import { Text, TouchableOpacity, View } from 'react-native';

import type { ContentItem } from '../../api';
import { colors, surface } from '../../design/tokens';

import styles from './Course.styles';

interface ContentTypeStyle {
  icon: string;
  color: string;
}

/**
 * Single source of truth for per-content_type presentation. Icon and background
 * live in one entry so they cannot drift apart, and the keys track the
 * content_type values the backend actually serves (production ships `chapter`;
 * `essay`/`prompt`/`video` are creatable via the course authoring endpoint).
 */
const CONTENT_TYPE_STYLES: Record<string, ContentTypeStyle> = {
  chapter: { icon: '📚', color: colors.tier.stretch },
  essay: { icon: '📖', color: colors.mystical.glowPurple },
  prompt: { icon: '💬', color: colors.tier.clear },
  video: { icon: '▶', color: colors.tier.low },
};

const DEFAULT_STYLE: ContentTypeStyle = { icon: '📄', color: surface.sunken };

const getSubtitle = (item: ContentItem): string => {
  if (item.is_locked) {
    return `Unlocks on day ${item.release_day}`;
  }
  if (item.is_read) {
    return 'Completed';
  }
  return item.content_type.charAt(0).toUpperCase() + item.content_type.slice(1);
};

const getStatusIndicator = (item: ContentItem): string => {
  if (item.is_locked) return '🔒';
  if (item.is_read) return '✓';
  return '›';
};

interface ContentCardProps {
  item: ContentItem;
  onPress: (_item: ContentItem) => void;
}

const ContentCard = ({ item, onPress }: ContentCardProps): React.JSX.Element => {
  const { icon, color: iconBg } = CONTENT_TYPE_STYLES[item.content_type] ?? DEFAULT_STYLE;

  return (
    <TouchableOpacity
      testID={`content-card-${item.id}`}
      accessible
      accessibilityRole="button"
      accessibilityLabel={`${item.title}${item.is_locked ? ', locked' : ''}${item.is_read ? ', read' : ''}`}
      disabled={item.is_locked}
      onPress={() => {
        if (item.is_locked) return;
        onPress(item);
      }}
      style={[
        styles.contentCard,
        item.is_locked && styles.contentCardLocked,
        item.is_read && styles.contentCardRead,
      ]}
    >
      <View
        testID={`content-card-icon-${item.id}`}
        style={[styles.contentCardIcon, { backgroundColor: iconBg }]}
      >
        <Text style={styles.contentCardIconText}>{icon}</Text>
      </View>
      <View style={styles.contentCardBody}>
        <Text style={styles.contentCardTitle} numberOfLines={1}>
          {item.title}
        </Text>
        <Text style={styles.contentCardSubtitle}>{getSubtitle(item)}</Text>
      </View>
      <View style={styles.contentCardStatus}>
        <Text style={styles.contentCardStatusText}>{getStatusIndicator(item)}</Text>
      </View>
    </TouchableOpacity>
  );
};

export default ContentCard;
