import React, { useCallback, useState } from 'react';
import { ActivityIndicator, Linking, Text, TouchableOpacity, View } from 'react-native';

import { course as courseApi, type ContentItem } from '../../api';

import styles from './Course.styles';

interface ViewerHeaderProps {
  title: string;
  onBack: () => void;
}

const ViewerHeader = ({ title, onBack }: ViewerHeaderProps): React.JSX.Element => (
  <View style={styles.viewerHeader}>
    <TouchableOpacity
      onPress={onBack}
      style={styles.viewerBackButton}
      testID="viewer-back-button"
      accessibilityRole="button"
      accessibilityLabel="Go back"
    >
      <Text style={styles.viewerBackText}>{'← Back'}</Text>
    </TouchableOpacity>
    <Text style={styles.viewerTitle} numberOfLines={1}>
      {title}
    </Text>
  </View>
);

interface ViewerFooterProps {
  isRead: boolean;
  marking: boolean;
  onMarkRead: () => void;
  onReflect?: () => void;
}

const ViewerFooter = ({
  isRead,
  marking,
  onMarkRead,
  onReflect,
}: ViewerFooterProps): React.JSX.Element => (
  <View style={styles.viewerFooter}>
    <TouchableOpacity
      testID="mark-read-button"
      onPress={onMarkRead}
      disabled={isRead || marking}
      style={[styles.markReadButton, isRead && styles.markReadButtonDone]}
      accessibilityRole="button"
      accessibilityLabel={isRead ? 'Already read' : 'Mark as Read'}
    >
      {marking ? (
        <ActivityIndicator testID="mark-read-loading" size="small" color="#fff" />
      ) : (
        <Text style={[styles.markReadText, isRead && styles.markReadTextDone]}>
          {isRead ? '✓ Read' : 'Mark as Read'}
        </Text>
      )}
    </TouchableOpacity>
    {isRead && onReflect && (
      <TouchableOpacity
        testID="reflect-button"
        onPress={onReflect}
        style={styles.reflectButton}
        accessibilityRole="button"
        accessibilityLabel="Reflect in Journal"
      >
        <Text style={styles.reflectText}>Reflect in Journal</Text>
      </TouchableOpacity>
    )}
  </View>
);

interface ContentViewerProps {
  item: ContentItem;
  onBack: () => void;
  onMarkRead: () => void;
  onReflect?: () => void;
}

const ContentViewer = ({
  item,
  onBack,
  onMarkRead,
  onReflect,
}: ContentViewerProps): React.JSX.Element => {
  const [marking, setMarking] = useState(false);
  const [isRead, setIsRead] = useState(item.is_read);

  const handleMarkRead = useCallback(async () => {
    if (isRead || marking) return;
    setMarking(true);
    try {
      await courseApi.markRead(item.id);
      setIsRead(true);
      onMarkRead();
    } catch (err) {
      console.error('Failed to mark content as read:', err);
    } finally {
      setMarking(false);
    }
  }, [isRead, marking, item.id, onMarkRead]);

  const handleOpenUrl = useCallback(async () => {
    if (!item.url) return;
    try {
      await Linking.openURL(item.url);
    } catch (err) {
      console.error('Failed to open URL:', err);
    }
  }, [item.url]);

  return (
    <View style={styles.viewerContainer} testID="content-viewer">
      <ViewerHeader title={item.title} onBack={onBack} />
      <View style={styles.loadingContainer}>
        <TouchableOpacity onPress={handleOpenUrl} testID="open-url-button">
          <Text style={styles.viewerBackText}>{'Open in Browser'}</Text>
        </TouchableOpacity>
      </View>
      <ViewerFooter
        isRead={isRead}
        marking={marking}
        onMarkRead={handleMarkRead}
        onReflect={onReflect}
      />
    </View>
  );
};

export default ContentViewer;
