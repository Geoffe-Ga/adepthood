export interface ChartBaseProps {
  summary: string;
  width?: number;
  height?: number;
  testID?: string;
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
