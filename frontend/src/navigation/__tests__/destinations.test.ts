import { describe, expect, it } from '@jest/globals';
import { BookOpen, Compass, Flower2, NotebookPen, Sprout } from 'lucide-react-native';

import { NAV_DESTINATIONS } from '@/navigation/destinations';

describe('NAV_DESTINATIONS', () => {
  it('has exactly five entries in the fixed nav order', () => {
    expect(NAV_DESTINATIONS).toHaveLength(5);
    expect(NAV_DESTINATIONS.map((d) => d.name)).toEqual([
      'Journal',
      'Habits',
      'Practice',
      'Course',
      'Map',
    ]);
  });

  it('maps each destination to its lucide icon by identity', () => {
    expect(NAV_DESTINATIONS[0]?.icon).toBe(NotebookPen);
    expect(NAV_DESTINATIONS[1]?.icon).toBe(Sprout);
    expect(NAV_DESTINATIONS[2]?.icon).toBe(Flower2);
    expect(NAV_DESTINATIONS[3]?.icon).toBe(BookOpen);
    expect(NAV_DESTINATIONS[4]?.icon).toBe(Compass);
  });

  it('leaves ring undefined for Journal and Map', () => {
    expect(NAV_DESTINATIONS[0]?.ring).toBeUndefined();
    expect(NAV_DESTINATIONS[4]?.ring).toBeUndefined();
  });

  it('tags Habits, Practice, and Course with their depth ring', () => {
    expect(NAV_DESTINATIONS[1]?.ring).toBe('habits');
    expect(NAV_DESTINATIONS[2]?.ring).toBe('practices');
    expect(NAV_DESTINATIONS[3]?.ring).toBe('course');
  });

  it('uses the screen name as the label for every destination', () => {
    NAV_DESTINATIONS.forEach((destination) => {
      expect(destination.label).toBe(destination.name);
    });
  });
});
