import React, { useEffect, useRef, useState } from 'react';
import { Text, TouchableOpacity, View } from 'react-native';

import { course as courseApi, type SiteResource } from '../../api';

import styles from './Course.styles';

interface SiteResourcesPanelProps {
  onSelect: (resource: SiteResource) => void;
}

/**
 * Always-available links to evergreen pages (philosophy, about, …).
 * Rendered as a chip row above the stage metadata.  The list is loaded
 * once per mount; it's small (<10 entries) so we don't paginate and we
 * don't refresh on focus — adding a new resource means a backend deploy.
 *
 * Renders nothing when the resource list is empty or still loading: the
 * panel is supplementary navigation, not a primary surface, so a
 * spinner here would steal vertical space from the actual course.
 */
const SiteResourcesPanel = ({ onSelect }: SiteResourcesPanelProps): React.JSX.Element | null => {
  const [resources, setResources] = useState<SiteResource[]>([]);
  const isMountedRef = useRef(true);

  useEffect(
    () => () => {
      isMountedRef.current = false;
    },
    [],
  );

  useEffect(() => {
    courseApi
      .siteResources()
      .then((list) => {
        if (!isMountedRef.current) return;
        setResources(list);
      })
      .catch((err: unknown) => {
        // Don't surface a banner — the resources panel is supplementary.
        // Logging keeps the failure visible in dev without spooking users.
        console.warn('Failed to load site resources:', err);
      });
  }, []);

  if (resources.length === 0) return null;

  return (
    <View style={styles.resourcesPanel} testID="site-resources-panel">
      <Text style={styles.resourcesHeading}>From Aptitude Guru</Text>
      <View style={styles.resourcesRow}>
        {resources.map((resource) => (
          <TouchableOpacity
            key={resource.slug}
            testID={`site-resource-chip-${resource.slug}`}
            style={styles.resourceChip}
            onPress={() => onSelect(resource)}
            accessibilityRole="button"
            accessibilityLabel={`Open ${resource.title}`}
          >
            <Text style={styles.resourceChipText}>{resource.title}</Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
};

export default SiteResourcesPanel;
