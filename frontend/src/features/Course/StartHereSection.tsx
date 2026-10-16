import React from 'react';
import { ActivityIndicator, FlatList, Text, TouchableOpacity, View } from 'react-native';

import styles from './Course.styles';
import RetryButton from './RetryButton';
import type { EnergyHandoffStatus } from './useEnergyScaffoldingHandoff';

import type { CourseProgress, SiteResource } from '@/api';
import { ShowcaseCard } from '@/components/layout/ShowcaseCard';

/** A failed read leaves progress unknown, so the copy claims nothing about it (#3344). */
export const START_HERE_ERROR_COPY = "Start Here couldn't load, so your progress isn't shown.";

interface Props {
  readNext?: React.ReactNode;
  resources: SiteResource[];
  progress: CourseProgress | null;
  status: 'idle' | 'loading' | 'ready' | 'error';
  onSelect: (_resource: SiteResource) => void;
  onRetry: () => void;
  habitsEnabled: boolean;
  energyStatus?: EnergyHandoffStatus;
  onStartEnergy: () => void;
}

function ResourceCard({
  resource,
  onSelect,
}: {
  resource: SiteResource;
  onSelect: Props['onSelect'];
}) {
  return (
    <TouchableOpacity
      testID={`start-here-resource-${resource.slug}`}
      accessibilityRole="button"
      accessibilityLabel={`Open ${resource.title}${resource.is_read ? ', read' : ''}`}
      style={[styles.contentCard, resource.is_read && styles.contentCardRead]}
      onPress={() => onSelect(resource)}
    >
      <View style={styles.contentCardBody}>
        <Text style={styles.contentCardTitle}>{resource.title}</Text>
        <Text style={styles.contentCardSubtitle}>{resource.description}</Text>
      </View>
      <View style={styles.contentCardStatus}>
        <Text style={styles.contentCardStatusText}>{resource.is_read ? '✓' : '›'}</Text>
      </View>
    </TouchableOpacity>
  );
}

function EnergyAction({
  energyStatus = 'idle',
  onStartEnergy,
}: Pick<Props, 'energyStatus' | 'onStartEnergy'>) {
  return (
    <View style={styles.resourceAction}>
      {energyStatus === 'disabled' ? (
        <Text style={styles.contentCardSubtitle}>
          Habits is turned off. You can change this in Settings.
        </Text>
      ) : (
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="Start Energy Scaffolding"
          disabled={energyStatus === 'checking'}
          onPress={onStartEnergy}
          style={styles.resourceActionButton}
        >
          <Text style={styles.readerWriteNoteLink}>Start Energy Scaffolding</Text>
          {energyStatus === 'checking' && (
            <ActivityIndicator accessibilityLabel="Checking your Habits setting" />
          )}
        </TouchableOpacity>
      )}
      {energyStatus === 'error' && (
        <Text style={styles.contentCardSubtitle}>
          We couldn't check your Habits setting. Try again.
        </Text>
      )}
    </View>
  );
}

function StartHereHeader({
  progress,
  status,
  onRetry,
  readNext,
}: Pick<Props, 'progress' | 'status' | 'onRetry' | 'readNext'>) {
  return (
    <View style={styles.startHereHeader}>
      <ShowcaseCard style={styles.stageCover}>
        <Text style={styles.stageCoverEyebrow}>New here? Start with these</Text>
        <Text style={styles.stageCoverTitle}>Start Here</Text>
        {progress && status !== 'error' && (
          <Text style={styles.stageCoverProgressLabel}>
            {progress.read_items} of {progress.total_items} read
          </Text>
        )}
        {status === 'loading' && <ActivityIndicator />}
        {status === 'error' && (
          <View style={styles.startHereError}>
            <Text style={styles.stageCoverSubtitle}>{START_HERE_ERROR_COPY}</Text>
            <RetryButton onRetry={onRetry} />
          </View>
        )}
      </ShowcaseCard>
      {readNext}
    </View>
  );
}

export default function StartHereSection({
  resources,
  progress,
  status,
  onSelect,
  onRetry,
  habitsEnabled,
  onStartEnergy,
  energyStatus = 'idle',
  readNext,
}: Props) {
  return (
    <FlatList
      testID="start-here-section"
      style={styles.contentList}
      contentContainerStyle={styles.contentListContent}
      data={resources}
      keyExtractor={(resource) => resource.slug}
      ListHeaderComponent={
        <StartHereHeader
          progress={progress}
          status={status}
          onRetry={onRetry}
          readNext={readNext}
        />
      }
      renderItem={({ item }) => (
        <View>
          <ResourceCard resource={item} onSelect={onSelect} />
          {item.slug === 'energy-scaffolding' && habitsEnabled && (
            <EnergyAction energyStatus={energyStatus} onStartEnergy={onStartEnergy} />
          )}
        </View>
      )}
    />
  );
}
