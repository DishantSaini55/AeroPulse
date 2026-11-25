export type ReportValue = string | number | null;
export type ReportRow = Record<string, ReportValue>;

export function csvCell(value: ReportValue) {
  let text = value == null ? '' : String(value);
  // Prevent spreadsheet programs interpreting user-entered text as a formula.
  if (/^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function toCsv(columns: readonly string[], rows: ReportRow[]) {
  return '\uFEFF' + [columns.map(csvCell).join(','), ...rows.map(row => columns.map(column => csvCell(row[column] ?? null)).join(','))].join('\r\n') + '\r\n';
}
