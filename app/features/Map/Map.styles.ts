// app/features/Map/Map.styles.ts

import { StyleSheet } from 'react-native';

import { radius, spacing } from '../../Sources/design/DesignSystem';

/**
 * Styles for the Map screen hotspot layout and modal.
 */
const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  background: {
    flex: 1,
    resizeMode: 'cover',
  },
  hotspot: {
    position: 'absolute',
    padding: spacing(1),
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
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
});

export default styles;
