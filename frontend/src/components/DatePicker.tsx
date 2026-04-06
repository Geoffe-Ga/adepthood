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
  onChange: (_value: string) => void;
  minDate?: string;
  maxDate?: string;
  disabledDate?: (_date: Date) => boolean;
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

const parseMDY = (trimmed: string): Date | null => {
  const mdy = trimmed.match(/^([0-9]{1,2})\/([0-9]{1,2})(?:\/([0-9]{2,4}))?$/);
  if (!mdy) return null;
  let year = mdy[3] ? Number.parseInt(mdy[3], 10) : new Date().getFullYear();
  if (year < 100) year += 2000;
  const month = Number.parseInt(mdy[1]!, 10) - 1;
  const day = Number.parseInt(mdy[2]!, 10);
  const date = new Date(year, month, day);
  return Number.isNaN(date.getTime()) ? null : date;
};

const parseMonthDay = (trimmed: string): Date | null => {
  const monthDay = trimmed.match(/^([a-zA-Z]+)\s+(\d{1,2})$/);
  if (!monthDay) return null;
  const md = Date.parse(`${monthDay[1]} ${monthDay[2]} ${new Date().getFullYear()}`);
  return Number.isNaN(md) ? null : new Date(md);
};

const parseISO = (trimmed: string): Date | null => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  const date = parseISODate(trimmed);
  return toISODate(date) === trimmed ? date : null;
};

export const parseDateInput = (input: string): Date | null => {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const result = parseMDY(trimmed) ?? parseMonthDay(trimmed) ?? parseISO(trimmed);
  if (result) return result;

  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

export const isDateWithinRange = (date: Date, min?: Date, max?: Date): boolean => {
  if (min && date < min) return false;
  if (max && date > max) return false;
  return true;
};

const validateDate = (
  date: Date,
  minDate?: string,
  maxDate?: string,
  disabledDate?: (_date: Date) => boolean,
): string | null => {
  const min = minDate ? parseISODate(minDate) : undefined;
  const max = maxDate ? parseISODate(maxDate) : undefined;
  if (!isDateWithinRange(date, min, max)) {
    return `between ${minDate ?? ''} and ${maxDate ?? ''}`;
  }
  if (disabledDate?.(date)) {
    return 'that day is blocked';
  }
  return null;
};

export const getLocalToday = (): Date => {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
};

export const getNextMonday = (): Date => {
  const local = getLocalToday();
  const dow = local.getDay();
  const add = (8 - dow) % 7 || 7;
  local.setDate(local.getDate() + add);
  return local;
};

export const getFirstOfNextMonth = (): Date => {
  const d = new Date();
  d.setMonth(d.getMonth() + 1, 1);
  return d;
};

const QUICK_BUTTON_STYLE = { marginLeft: 12 };
const ROW_STYLE = { flexDirection: 'row' as const, marginTop: 8 };

interface QuickDateButtonsProps {
  onSelectDate: (_date: Date) => void;
}

const QuickDateButtons: React.FC<QuickDateButtonsProps> = ({ onSelectDate }) => (
  <View style={ROW_STYLE}>
    <TouchableOpacity
      onPress={() => onSelectDate(getLocalToday())}
      accessibilityLabel="Select today"
    >
      <Text>today</Text>
    </TouchableOpacity>
    <TouchableOpacity
      onPress={() => onSelectDate(getNextMonday())}
      style={QUICK_BUTTON_STYLE}
      accessibilityLabel="Select next Monday"
    >
      <Text>next monday</Text>
    </TouchableOpacity>
    <TouchableOpacity
      onPress={() => onSelectDate(getFirstOfNextMonth())}
      style={QUICK_BUTTON_STYLE}
      accessibilityLabel="Select first of next month"
    >
      <Text>first of next month</Text>
    </TouchableOpacity>
  </View>
);

const useCommitDate = (
  onChange: (_value: string) => void,
  setError: (_err: string | null) => void,
  minDate?: string,
  maxDate?: string,
  disabledDate?: (_date: Date) => boolean,
) => {
  return (date: Date) => {
    const normalized = new Date(date);
    normalized.setHours(0, 0, 0, 0);
    const validationError = validateDate(normalized, minDate, maxDate, disabledDate);
    if (validationError) {
      setError(validationError);
      return;
    }
    setError(null);
    onChange(toISODate(normalized));
  };
};

interface NativePickerProps {
  value: string;
  minDate?: string;
  maxDate?: string;
  pickerVisible: boolean;
  setPickerVisible: (_v: boolean) => void;
  commitDate: (_date: Date) => void;
}

const NativePicker: React.FC<NativePickerProps> = ({
  value,
  minDate,
  maxDate,
  pickerVisible,
  setPickerVisible,
  commitDate,
}) => (
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
);

interface DateInputProps {
  value: string;
  minDate?: string;
  maxDate?: string;
  textValue: string;
  onChangeText: (_t: string) => void;
  onFocus: () => void;
  commitDate: (_date: Date) => void;
}

const DateInput: React.FC<DateInputProps> = ({
  value,
  minDate,
  maxDate,
  textValue,
  onChangeText,
  onFocus,
  commitDate,
}) =>
  Platform.OS === 'web' ? (
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
      onChangeText={onChangeText}
      onFocus={onFocus}
    />
  );

const makeHandleChangeText = (
  setTextValue: (_v: string) => void,
  setError: (_e: string | null) => void,
  commitDate: (_d: Date) => void,
) => {
  return (t: string) => {
    setTextValue(t);
    const parsed = parseDateInput(t);
    if (!parsed) {
      setError('use YYYY-MM-DD');
      return;
    }
    commitDate(parsed);
  };
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

  const commitDate = useCommitDate(onChange, setError, minDate, maxDate, disabledDate);
  const handleChangeText = makeHandleChangeText(setTextValue, setError, commitDate);

  return (
    <View>
      <DateInput
        value={value}
        minDate={minDate}
        maxDate={maxDate}
        textValue={textValue}
        onChangeText={handleChangeText}
        onFocus={() => setPickerVisible(true)}
        commitDate={commitDate}
      />
      {error && <Text accessibilityRole="alert">{error}</Text>}
      {Platform.OS !== 'web' && (
        <NativePicker
          value={value}
          minDate={minDate}
          maxDate={maxDate}
          pickerVisible={pickerVisible}
          setPickerVisible={setPickerVisible}
          commitDate={commitDate}
        />
      )}
      <QuickDateButtons onSelectDate={commitDate} />
    </View>
  );
};

export default DatePicker;
