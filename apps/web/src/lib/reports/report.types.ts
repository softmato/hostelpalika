export type ReportExport = {
  columns: Array<{ key: string; label: string }>;
  filenamePrefix: string;
  /** What the rows cover — "Last 6 months". Absent on a snapshot. */
  period?: string;
  rows: Array<Record<string, unknown>>;
};
