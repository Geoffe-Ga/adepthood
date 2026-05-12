/**
 * Program start date persistence.
 *
 * The program start date is the master anchor for the 36-week APTITUDE
 * journey: BotMason's weekly prompt, the active practice, the unlocked
 * course content, and the highlighted map stage all derive from
 * ``today - programStartDate``.  It is stored in AsyncStorage as an
 * ISO-8601 date string (``YYYY-MM-DD``) so that the calendar day is
 * preserved across timezone changes.  ``null`` means the user has not
 * picked a start date yet -- consumers must then fall back to their
 * server-derived progression signal.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const PROGRAM_START_DATE_KEY = '@adepthood/program_start_date';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const toISODate = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const parseISODate = (iso: string): Date | null => {
  if (!ISO_DATE_RE.test(iso)) return null;
  const [yStr, mStr, dStr] = iso.split('-');
  const year = Number(yStr);
  const month = Number(mStr);
  const day = Number(dStr);
  const date = new Date(year, month - 1, day);
  return Number.isNaN(date.getTime()) ? null : date;
};

export async function saveProgramStartDate(date: Date): Promise<void> {
  await AsyncStorage.setItem(PROGRAM_START_DATE_KEY, toISODate(date));
}

export async function loadProgramStartDate(): Promise<Date | null> {
  try {
    const raw = await AsyncStorage.getItem(PROGRAM_START_DATE_KEY);
    if (raw === null) return null;
    return parseISODate(raw);
  } catch (err) {
    console.warn('[programStorage] failed to load program start date', err);
    return null;
  }
}

export async function clearProgramStartDate(): Promise<void> {
  await AsyncStorage.removeItem(PROGRAM_START_DATE_KEY);
}
