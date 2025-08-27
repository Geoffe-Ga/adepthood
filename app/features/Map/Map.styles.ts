// app/features/Map/Map.styles.ts

import { StyleSheet } from 'react-native';

import { radius, spacing } from '../../Sources/design/DesignSystem';

/**
 * Styles for the Map screen and its stage cards.
 */
const styles = StyleSheet.create({
  container: {
    padding: spacing(2),
    backgroundColor: '#fdfcf8',
  },
  card: {
    backgroundColor: '#fff',
    marginBottom: spacing(2),
    padding: spacing(2),
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: '#eee',
  },
  title: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: spacing(0.5),
  },
  subtitle: {
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
  meta: {
    marginTop: spacing(1),
    fontSize: 12,
    color: '#555',
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: spacing(1),
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
