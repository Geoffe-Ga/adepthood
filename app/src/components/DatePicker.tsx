import React, { useEffect, useState } from 'react';
import type { ComponentType } from 'react';
import { Platform, Text, TextInput, TouchableOpacity, View } from 'react-native';

let DateTimePickerModal: ComponentType<Record<string, unknown>> = () => null;
if (Platform.OS !== 'web') {
  try {
    DateTimePickerModal = require('react-native-modal-datetime-picker').default;
  } catch {
    DateTimePickerModal = () => null;
  }
}

export interface DatePickerProps {
  value: string;
  onChange: (value: string) => void; // eslint-disable-line no-unused-vars
  minDate?: string;
  maxDate?: string;
  disabledDate?: (date: Date) => boolean; // eslint-disable-line no-unused-vars
  locale?: string;
  mode?: 'scaffoldingStart' | 'courseStart';
  stageColor?: string;
}

export const toISODate = (date: Date): string => {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

export const parseISODate = (iso: string): Date => {
  const [yStr, mStr, dStr] = iso.split('-');
  const y = Number(yStr);
  const m = Number(mStr ?? 1);
  const d = Number(dStr ?? 1);
  return new Date(y, m - 1, d);
};

export const formatDisplayDate = (date: Date, locale = 'en-US'): string =>
  date.toLocaleDateString(locale, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });

export const parseDateInput = (input: string): Date | null => {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // MM/DD/YY or MM/DD/YYYY
  const mdy = trimmed.match(/^([0-9]{1,2})\/([0-9]{1,2})(?:\/([0-9]{2,4}))?$/);
  if (mdy) {
    let year = mdy[3] ? Number.parseInt(mdy[3], 10) : new Date().getFullYear();
    if (year < 100) year += 2000;
    const month = Number.parseInt(mdy[1]!, 10) - 1;
    const day = Number.parseInt(mdy[2]!, 10);
    const date = new Date(year, month, day);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  // Month name and day, e.g., Sep 1
  const monthDay = trimmed.match(/^([a-zA-Z]+)\s+(\d{1,2})$/);
  if (monthDay) {
    const md = Date.parse(`${monthDay[1]} ${monthDay[2]} ${new Date().getFullYear()}`);
    if (!Number.isNaN(md)) {
      return new Date(md);
    }
  }
  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const date = parseISODate(trimmed);
    return toISODate(date) === trimmed ? date : null;
  }

  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

export const isDateWithinRange = (date: Date, min?: Date, max?: Date): boolean => {
  if (min && date < min) return false;
  if (max && date > max) return false;
  return true;
};

const DatePicker: React.FC<DatePickerProps> = ({
  value,
  onChange,
  minDate,
  maxDate,
  disabledDate,
  locale = 'en-US',
}) => {
  const [textValue, setTextValue] = useState(
    value ? formatDisplayDate(parseISODate(value), locale) : '',
  );
  const [error, setError] = useState<string | null>(null);
  const [pickerVisible, setPickerVisible] = useState(false);

  useEffect(() => {
    if (value) {
      setTextValue(formatDisplayDate(parseISODate(value), locale));
    }
  }, [value, locale]);

  const commitDate = (date: Date) => {
    const normalized = new Date(date);
    normalized.setHours(0, 0, 0, 0);
    if (minDate || maxDate || disabledDate) {
      const min = minDate ? parseISODate(minDate) : undefined;
      const max = maxDate ? parseISODate(maxDate) : undefined;
      if (!isDateWithinRange(normalized, min, max)) {
        setError(`between ${minDate ?? ''} and ${maxDate ?? ''}`);
        return;
      }
      if (disabledDate && disabledDate(normalized)) {
        setError('that day is blocked');
        return;
      }
    }
    setError(null);
    onChange(toISODate(normalized));
  };

  const handleChangeText = (t: string) => {
    setTextValue(t);
    const parsed = parseDateInput(t);
    if (!parsed) {
      setError('use YYYY-MM-DD');
      return;
    }
    commitDate(parsed);
  };

  const quickToday = () => {
    const now = new Date();
    const local = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    commitDate(local);
  };
  const quickNextMonday = () => {
    const now = new Date();
    const local = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const dow = local.getDay();
    const add = (8 - dow) % 7 || 7;
    local.setDate(local.getDate() + add);
    commitDate(local);
  };
  const quickFirstNextMonth = () => {
    const d = new Date();
    d.setMonth(d.getMonth() + 1, 1);
    commitDate(d);
  };

  return (
    <View>
      {Platform.OS === 'web' ? (
        <input
          aria-label="Date"
          type="date"
          value={value}
          min={minDate}
          max={maxDate}
          onChange={(e) => commitDate(parseISODate(e.target.value))}
        />
      ) : (
        <TextInput
          accessibilityLabel="Date"
          placeholder="Select date"
          value={textValue}
          onChangeText={handleChangeText}
          onFocus={() => setPickerVisible(true)}
        />
      )}
      {error && <Text accessibilityRole="alert">{error}</Text>}
      {Platform.OS !== 'web' && (
        <DateTimePickerModal
          isVisible={pickerVisible}
          mode="date"
          date={value ? parseISODate(value) : new Date()}
          minimumDate={minDate ? parseISODate(minDate) : undefined}
          maximumDate={maxDate ? parseISODate(maxDate) : undefined}
          onConfirm={(date: Date) => {
            setPickerVisible(false);
            commitDate(date);
          }}
          onCancel={() => setPickerVisible(false)}
        />
      )}
      <View style={{ flexDirection: 'row', marginTop: 8 }}>
        <TouchableOpacity onPress={quickToday} accessibilityLabel="Select today">
          <Text>today</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={quickNextMonday}
          style={{ marginLeft: 12 }}
          accessibilityLabel="Select next Monday"
        >
          <Text>next monday</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={quickFirstNextMonth}
          style={{ marginLeft: 12 }}
          accessibilityLabel="Select first of next month"
        >
          <Text>first of next month</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
};

export default DatePicker;
