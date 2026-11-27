import { z } from 'zod';
import type { ReportRow } from './csv.js';

export const reportTitles = {
  health: 'Daily Infrastructure Health Report',
  incidents: 'Incident Report',
  diagnostics: 'Equipment Diagnostic Report',
  reliability: 'Equipment Reliability Report',
  preventive: 'Preventive Maintenance Report',
  completion: 'Work Order Completion Report',
  expenditure: 'Maintenance Expenditure Report',
  recommendations: 'Equipment Replacement Recommendation Report',
  failover: 'Failover and Service Availability Report',
  executive: 'Executive Infrastructure Summary',
} as const;
export type DocumentType = keyof typeof reportTitles;
export const documentTypes = Object.keys(reportTitles) as [DocumentType,...DocumentType[]];
export const documentFilterSchema = z.strictObject({
  type: z.enum(documentTypes), from: z.iso.date(), to: z.iso.date(),
  device: z.string().trim().min(1).max(48).optional(), system: z.string().trim().min(1).max(32).optional(),
  incidentId: z.uuid().optional(), workOrderId: z.uuid().optional(),
  format: z.enum(['pdf','json','csv']).default('pdf'),
});
export type DocumentFilter = z.infer<typeof documentFilterSchema>;
export type ReportSection = { title: string; columns: { key: string; label: string; weight?: number }[]; rows: ReportRow[]; note?: string };
export type ReportDocument = {
  id: string; type: DocumentType; title: string; generatedAt: string;
  generatedBy: { id: string; name: string; role: string }; filters: Omit<DocumentFilter,'format'>;
  summary: { label: string; value: string }[]; sections: ReportSection[]; notes: string[]; rowCount: number; simulated: true;
};
export class ReportError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); }
}
export const reportLimits = { days: 90, rows: 1000, characters: 600000, pages: 80, bytes: 8*1024*1024, concurrent: 2 } as const;
export function reportWindow(filter: DocumentFilter) {
  const from = new Date(filter.from+'T00:00:00.000Z'), to = new Date(filter.to+'T00:00:00.000Z');
  if (to < from || (to.getTime()-from.getTime())/86400000 >= reportLimits.days)
    throw new ReportError('INVALID_WINDOW','Choose an inclusive UTC reporting period of at most 90 days');
  if (filter.incidentId && !['incidents','preventive','completion','expenditure'].includes(filter.type))
    throw new ReportError('INCOMPATIBLE_FILTER','Incident selection is supported for incident and work-order reports');
  if (filter.workOrderId && !['preventive','completion','expenditure'].includes(filter.type))
    throw new ReportError('INCOMPATIBLE_FILTER','Work-order selection is supported for maintenance reports');
  return { from, to: new Date(to.getTime()+86400000) };
}
export function boundRows<T>(rows: T[]): T[] {
  if (rows.length > reportLimits.rows) throw new ReportError('REPORT_TOO_LARGE','More than 1,000 records. Narrow the reporting period or selections.',413);
  return rows;
}
export function validateDocumentSize(report: ReportDocument) {
  report.rowCount = report.sections.reduce((sum,section)=>sum+section.rows.length,0);
  if (report.rowCount > reportLimits.rows || JSON.stringify(report).length > reportLimits.characters)
    throw new ReportError('REPORT_TOO_LARGE','Report exceeds the row or text budget. Narrow the filters.',413);
  return report;
}
