import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Text, TouchableOpacity, View } from 'react-native';

import { course as courseApi, type SiteResource } from '../../api';
import { colors } from '../../design/tokens';

import ChapterReader from './ChapterReader';
import styles from './Course.styles';

import { useMountedRef } from '@/hooks/useMountedRef';
import { reportDiagnostic } from '@/observability/diagnostics';

/** The two keys a Start Here reader needs: which page, and what to call it. */
export type ResourceTarget = Pick<SiteResource, 'slug' | 'title'>;

export const MARK_RESOURCE_READ_LABEL = 'Mark as Read';
export const RESOURCE_READ_LABEL = '✓ Read';

/**
 * Mark the on-screen Start Here resource read (#3234).
 *
 * The backend mark is idempotent, so the button starts unread rather than
 * waiting on a separate read-state lookup: a second mark of an already-read
 * page is a no-op, never an error. A request that resolves after the reader has
 * moved to another resource (or left) does not label what is now on screen.
 */
function useResourceMarkRead(
  slug: string,
  onMarkedRead: () => void,
): { marking: boolean; isRead: boolean; handleMarkRead: () => Promise<void> } {
  const [marking, setMarking] = useState(false);
  const [isRead, setIsRead] = useState(false);
  const currentSlugRef = useRef(slug);
  const isMountedRef = useMountedRef();

  useEffect(() => {
    currentSlugRef.current = slug;
    setIsRead(false);
    setMarking(false);
  }, [slug]);

  const handleMarkRead = useCallback(async () => {
    if (isRead || marking) return;
    const requestedSlug = slug;
    setMarking(true);
    try {
      await courseApi.markResourceRead(requestedSlug);
      if (!isMountedRef.current) return;
      // The mark persisted server-side whichever page is showing now, so the
      // reading position is re-asked regardless.
      onMarkedRead();
      if (currentSlugRef.current === requestedSlug) setIsRead(true);
    } catch {
      reportDiagnostic('course_read_failed');
    } finally {
      if (isMountedRef.current && currentSlugRef.current === requestedSlug) setMarking(false);
    }
  }, [isRead, marking, slug, onMarkedRead, isMountedRef]);

  return { marking, isRead, handleMarkRead };
}

interface ResourceFooterProps {
  isRead: boolean;
  marking: boolean;
  onMarkRead: () => void;
}

/** The resource reader's single control, offered once the page's end is in view. */
const ResourceFooter = ({
  isRead,
  marking,
  onMarkRead,
}: ResourceFooterProps): React.JSX.Element => (
  <View testID="resource-footer" pointerEvents="box-none" style={styles.viewerFooter}>
    <View style={styles.viewerFooterRow}>
      <TouchableOpacity
        testID="resource-mark-read-button"
        onPress={onMarkRead}
        disabled={isRead || marking}
        style={[styles.markReadButton, isRead && styles.markReadButtonDone]}
        accessibilityRole="button"
        accessibilityLabel={isRead ? 'Already read' : MARK_RESOURCE_READ_LABEL}
      >
        {marking ? (
          <ActivityIndicator
            testID="resource-mark-read-loading"
            size="small"
            color={colors.text.light}
          />
        ) : (
          <Text style={[styles.buttonLabelOnAccent, isRead && styles.markReadTextDone]}>
            {isRead ? RESOURCE_READ_LABEL : MARK_RESOURCE_READ_LABEL}
          </Text>
        )}
      </TouchableOpacity>
    </View>
  </View>
);

interface ResourceViewerProps {
  resource: ResourceTarget;
  onBack: () => void;
  /** Called once a mark persists, so the "Read next" target can move on. */
  onMarkedRead: () => void;
}

/**
 * A Start Here page in the shared reader, with a Mark as Read control so the
 * "Read next" walk can move past it (#3234). Without the mark a reader sent
 * here by "Read next" would be sent back to the same page forever.
 */
const ResourceViewer = ({
  resource,
  onBack,
  onMarkedRead,
}: ResourceViewerProps): React.JSX.Element => {
  const { marking, isRead, handleMarkRead } = useResourceMarkRead(resource.slug, onMarkedRead);
  return (
    <ChapterReader
      source={{ kind: 'resource', slug: resource.slug }}
      fallbackTitle={resource.title}
      onBack={onBack}
      renderFooter={(atEssayEnd) =>
        atEssayEnd ? (
          <ResourceFooter
            isRead={isRead}
            marking={marking}
            onMarkRead={() => void handleMarkRead()}
          />
        ) : null
      }
    />
  );
};

export default ResourceViewer;
