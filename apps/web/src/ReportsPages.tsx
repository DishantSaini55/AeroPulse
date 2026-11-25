import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, FileSpreadsheet, History, RefreshCw } from 'lucide-react';
import { downloadReportCsv, getAuditEvents, getReport, type AuditFilters, type ReportFilters, type ReportType } from './api';
import { formatUtcDateTime } from './time';
import './reports.css';

const todayUtc = new Date().toISOString().slice(0, 10);
const monthAgoUtc = new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10);
const labels: Record<ReportType, string> = { incidents: 'Incident history', repairs: 'Repair ledger', replacements: 'Replacement ledger', failovers: 'Failover history', audit: 'Audit activity' };
const printable = (value: string | number | null | undefined) => value == null || value === '' ? '—' : String(value);

export function ReportsPage() {
  const [filters, setFilters] = useState<ReportFilters>({ type: 'incidents', from: monthAgoUtc, to: todayUtc, device: '', system: '' });
  const [submitted, setSubmitted] = useState(filters);
  const [downloadError, setDownloadError] = useState('');
  const query = useQuery({ queryKey: ['report', submitted], queryFn: () => getReport(submitted), enabled: false });
  const filtersChanged = JSON.stringify(filters) !== JSON.stringify(submitted);
  function submit(event: React.FormEvent) { event.preventDefault(); setDownloadError(''); setSubmitted({ ...filters }); void query.refetch(); }
  async function download() { setDownloadError(''); try { await downloadReportCsv(submitted); } catch (error) { setDownloadError(error instanceof Error ? error.message : 'CSV export failed'); } }
  return <><div className="page-heading"><span className="eyebrow">OPERATIONS / REPORTS</span><h1>Recorded activity reports</h1><p>Filter persisted simulation records by UTC date, device or system, review the result, then export the same rows as CSV.</p></div>
    <div className="notice neutral-notice"><FileSpreadsheet size={17} /><strong>RECORDED SIMULATION DATA</strong><span>CSV content is spreadsheet-safe. Report generation is limited to 365 days and 5,000 rows.</span></div>
    <form className="panel report-filters" onSubmit={submit}>
      <label>Report<select value={filters.type} onChange={event => setFilters(current => ({ ...current, type: event.target.value as ReportType }))}>{(Object.keys(labels) as ReportType[]).map(type => <option key={type} value={type}>{labels[type]}</option>)}</select></label>
      <label>UTC from<input type="date" required value={filters.from} onChange={event => setFilters(current => ({ ...current, from: event.target.value }))} /></label>
      <label>UTC to<input type="date" required value={filters.to} onChange={event => setFilters(current => ({ ...current, to: event.target.value }))} /></label>
      {filters.type !== 'audit' && <label>Device (optional)<input maxLength={48} placeholder="e.g. ILS-P" value={filters.device ?? ''} onChange={event => setFilters(current => ({ ...current, device: event.target.value }))} /></label>}
      {filters.type !== 'audit' && <label>System (optional)<input maxLength={32} placeholder="e.g. ILS" value={filters.system ?? ''} onChange={event => setFilters(current => ({ ...current, system: event.target.value }))} /></label>}
      <div className="report-actions"><button type="submit" disabled={query.isFetching}><RefreshCw size={15} className={query.isFetching ? 'spin' : ''} /> Generate</button><button type="button" className="secondary-button" onClick={() => void download()} disabled={query.isFetching || !query.data || filtersChanged}><Download size={15} /> Download CSV</button></div>
      {downloadError && <p className="form-error" role="alert">{downloadError}</p>}
    </form>
    {query.isFetching && <div className="state-panel"><RefreshCw size={17} className="spin" /> Generating report…</div>}
    {query.error && <div className="state-panel state-error">{query.error.message}</div>}
    {query.data && <section className="panel report-result"><div className="panel-head"><div><span className="eyebrow">{labels[query.data.type].toUpperCase()}</span><h2>{query.data.total} rows</h2></div><small>{query.data.queryMs} ms · Generated {formatUtcDateTime(query.data.generatedAt)}</small></div>{query.data.rows.length ? <div className="table-wrap"><table><thead><tr>{query.data.columns.map(column => <th key={column}>{column}</th>)}</tr></thead><tbody>{query.data.rows.map((row, index) => <tr key={index}>{query.data!.columns.map(column => <td key={column}>{printable(row[column])}</td>)}</tr>)}</tbody></table></div> : <div className="state-panel">No recorded rows match these UTC filters.</div>}<p className="report-note">{query.data.note}</p></section>}
  </>;
}

export function EventHistoryPage() {
  const [filters, setFilters] = useState<AuditFilters>({ page: 1, limit: 30, outcome: 'all' });
  const query = useQuery({ queryKey: ['audit-events', filters], queryFn: () => getAuditEvents(filters), refetchInterval: 60_000 });
  const totalPages = query.data ? Math.max(1, Math.ceil(query.data.total / query.data.limit)) : 1;
  function update(next: Partial<AuditFilters>) { setFilters(current => ({ ...current, ...next, page: next.page ?? 1 })); }
  return <><div className="page-heading"><span className="eyebrow">GOVERNANCE / EVENT HISTORY</span><h1>Audit activity</h1><p>Authenticated operations requests are recorded after the HTTP response, with the actor, role, route, status and UTC time.</p></div>
    <div className="notice neutral-notice"><History size={17} /><strong>BEST-EFFORT AUDIT TRAIL</strong><span>Request bodies, credentials and tokens are excluded. The audit write is separate from the original operation.</span></div>
    <div className="panel audit-filters"><label>UTC from<input type="date" value={filters.from ?? ''} onChange={event => update({ from: event.target.value || undefined })} /></label><label>UTC to<input type="date" value={filters.to ?? ''} onChange={event => update({ to: event.target.value || undefined })} /></label><label>Outcome<select value={filters.outcome} onChange={event => update({ outcome: event.target.value as AuditFilters['outcome'] })}><option value="all">All outcomes</option><option value="success">Success (&lt; 400)</option><option value="failure">Failure (400+)</option></select></label></div>
    {query.isPending ? <div className="state-panel"><RefreshCw size={17} className="spin" /> Loading audit activity…</div> : query.error ? <div className="state-panel state-error">{query.error.message}</div> : query.data && <section className="panel report-result"><div className="panel-head"><div><span className="eyebrow">RECORDED REQUESTS</span><h2>{query.data.total} events</h2></div><small>Page {query.data.page} of {totalPages}</small></div>{query.data.data.length ? <div className="table-wrap"><table><thead><tr><th>UTC TIME</th><th>ACTOR</th><th>ROLE</th><th>METHOD</th><th>ROUTE</th><th>STATUS</th></tr></thead><tbody>{query.data.data.map(event => <tr key={event.id}><td>{formatUtcDateTime(event.occurredAt)}</td><td>{event.actor.name}<small> {event.actor.email}</small></td><td>{event.actorRole.replaceAll('_', ' ')}</td><td>{event.method}</td><td className="report-path">{event.path}</td><td><span className={event.statusCode < 400 ? 'audit-success' : 'audit-failure'}>{event.statusCode}</span></td></tr>)}</tbody></table></div> : <div className="state-panel">No audit records match these filters.</div>}<div className="report-pagination"><button disabled={filters.page === 1} onClick={() => update({ page: filters.page - 1 })}>Previous</button><button disabled={filters.page >= totalPages} onClick={() => update({ page: filters.page + 1 })}>Next</button></div><p className="report-note">{query.data.note}</p></section>}
  </>;
}
