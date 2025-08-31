// app/features/Map/Map.styles.ts

import { StyleSheet } from 'react-native';

import { radius, spacing } from '../../Sources/design/DesignSystem';

/**
 * Styles for the Map screen hotspot layout and modal.
 */
const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  hotspot: {
    position: 'absolute',
    // Transparent but still receives touch events
    backgroundColor: 'rgba(255,255,255,0.01)',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalContent: {
    width: '80%',
    backgroundColor: '#fff',
    padding: spacing(2),
    borderRadius: radius.md,
    position: 'relative',
  },
  modalTitle: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: spacing(0.5),
  },
  modalSubtitle: {
    fontSize: 14,
    marginBottom: spacing(1),
  },
  progressBar: {
    height: 8,
    backgroundColor: '#eee',
    borderRadius: radius.sm,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: '#7c3aed',
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: spacing(2),
  },
  actionButton: {
    backgroundColor: '#ede9fe',
    paddingVertical: spacing(1),
    paddingHorizontal: spacing(2),
    borderRadius: radius.sm,
  },
  actionText: {
    fontSize: 14,
    color: '#1e1e1e',
  },
  closeButton: {
    position: 'absolute',
    top: spacing(1),
    right: spacing(1),
    padding: spacing(0.5),
  },
  closeText: {
    fontSize: 16,
    fontWeight: '600',
  },
});

export default styles;
