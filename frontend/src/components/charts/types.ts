import type { LucideIcon } from 'lucide-react-native';

export interface ChartBaseProps {
  summary: string;
  width?: number;
  height?: number;
  testID?: string;
}

/** A glyph on a chart's header row that opens somewhere else, named for where it goes. */
export interface ChartDoor {
  label: string;
  hint: string;
  icon: LucideIcon;
  onPress: () => void;
}

export interface ChartTableRow {
  label: string;
  values: readonly (number | string)[];
}

export interface ChartAsk {
  value: number;
  label: string;
}

export interface ChartPoint {
  label: string;
  value: number;
  hollow?: boolean;
  stateLabel?: string;
}

export interface ChartColumn {
  label: string;
  segments: readonly number[];
  quiet?: number;
  emphasis?: boolean;
}

export interface RibbonBlock {
  label: string;
  weeks: number;
  color: string;
}

export interface LabelledSwatch {
  label: string;
  color: string;
}
