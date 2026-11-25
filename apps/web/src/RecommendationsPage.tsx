import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { NavLink } from 'react-router';
import { Check, ClipboardCheck, RefreshCw, X } from 'lucide-react';
import { decideRecommendation, getRecommendations, type Recommendation, type RecommendationAction } from './api';
import { useAuth } from './auth';
import { formatUtcDateTime } from './time';
import './recommendations.css';

const labels: Record<RecommendationAction, string> = {
  CONTINUE_MONITORING: 'Continue monitoring',
  PREVENTIVE_MAINTENANCE: 'Preventive maintenance',
  DETAILED_INVESTIGATION: 'Detailed investigation',
  COMPONENT_REPLACEMENT: 'Component replacement review',
  EQUIPMENT_REPLACEMENT_REVIEW: 'Complete equipment replacement review',
};
const currency = (value: number | null) => value == null ? 'Not recorded' : `₹${value.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const elapsed = (ms: number) => ms < 60_000 ? `${Math.round(ms / 1000)} sec` : ms < 3_600_000 ? `${(ms / 60_000).toFixed(1)} min` : `${(ms / 3_600_000).toFixed(1)} h`;

function RecommendationCard({ item, canDecide }: { item: Recommendation; canDecide: boolean }) {
  const client = useQueryClient();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function decide(decision: 'APPROVED' | 'DECLINED') {
    setError('');
    if (note.trim().length < 3) { setError('Enter a review note of at least 3 characters.'); return; }
    setBusy(true);
    try {
      await decideRecommendation(item, decision, note.trim());
      await client.invalidateQueries({ queryKey: ['recommendations'] });
      setNote('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save decision'); }
    finally { setBusy(false); }
  }
  return <article className="panel recommendation-card">
    <div className="recommendation-head"><div><span className="eyebrow">{item.systemCode} / {item.deviceCode}</span><h2>{labels[item.action]}</h2><p>{item.deviceName} · {item.rootCause}</p></div><span className={`recommendation-count ${item.similarFailures >= 5 ? 'critical' : ''}`}>{item.similarFailures} similar {item.similarFailures === 1 ? 'failure' : 'failures'}</span></div>
    <p className="recommendation-rationale">{item.rationale} Latest failure: {formatUtcDateTime(item.latestFailureAt)}.</p>
    <div className="recommendation-evidence">
      <div><span>Repeated component</span><strong>{item.component} · {item.componentFailures} episodes</strong></div>
      <div><span>Repair records / cost</span><strong>{item.repairCount} / {currency(item.repairCost)}</strong></div>
      <div><span>Unit age</span><strong>{item.equipmentAgeDays == null ? 'Unknown' : `${item.equipmentAgeDays} days`}</strong></div>
      <div><span>Missing-heartbeat downtime</span><strong>{elapsed(item.downtimeMs)}</strong></div>
      <div><span>30-day repair cost estimate</span><strong>{currency(item.projected30DayRepairCost)}</strong></div>
      <div><span>Last recorded unit replacement cost</span><strong>{currency(item.latestReplacementCost)}</strong></div>
    </div>
    <div className="recommendation-footer"><NavLink to={`/maintenance/${item.deviceCode}`} className="text-link">View maintenance history →</NavLink><NavLink to="/diagnostics" className="text-link">Review diagnosis →</NavLink></div>
    {item.decision ? <div className={`recommendation-decision ${item.decision.decision === 'APPROVED' ? 'approved' : 'declined'}`}><strong>{item.decision.decision === 'APPROVED' ? 'Recommendation approved' : 'Declined'}</strong><span>{item.decision.note}</span><small>{item.decision.decidedBy.name} · {formatUtcDateTime(item.decision.decidedAt)}</small>{item.decision.decision === 'APPROVED' && item.action === 'EQUIPMENT_REPLACEMENT_REVIEW' && <small>Physical replacement must still be recorded by a supervisor in maintenance history.</small>}</div>
      : canDecide ? <div className="recommendation-review"><label>Supervisor decision note<textarea value={note} onChange={event => setNote(event.target.value)} minLength={3} maxLength={2000} placeholder="Evidence reviewed and next maintenance step" /></label><div><button type="button" disabled={busy} onClick={() => void decide('APPROVED')}><Check size={15} /> Approve recommendation</button><button type="button" className="secondary-button" disabled={busy} onClick={() => void decide('DECLINED')}><X size={15} /> Decline</button></div>{error && <p className="form-error" role="alert">{error}</p>}</div>
        : <p className="recommendation-awaiting">Awaiting supervisor review.</p>}
  </article>;
}

export function RecommendationsPage() {
  const { user } = useAuth();
  const query = useQuery({ queryKey: ['recommendations'], queryFn: getRecommendations, refetchInterval: 60_000 });
  const canDecide = user?.role === 'SUPERVISOR' || user?.role === 'ADMINISTRATOR';
  const rows = query.data?.data ?? [];
  return <><div className="page-heading"><span className="eyebrow">MAINTENANCE / DECISION SUPPORT</span><h1>Replacement recommendations</h1><p>Recurring confirmed faults and recorded costs inform a human maintenance decision.</p></div>
    <div className="notice neutral-notice"><ClipboardCheck size={17} /><strong>SIMULATED DECISION SUPPORT</strong><span>Recommendations do not change equipment state. A supervisor must approve decisions and separately record physical replacement.</span></div>
    {query.isPending ? <div className="state-panel"><RefreshCw size={17} className="spin" /> Calculating recommendations…</div> : query.error ? <div className="state-panel state-error">{query.error.message}</div> : <>
      <div className="recommendation-summary"><div className="panel"><span>CONFIRMED CAUSE GROUPS</span><strong>{rows.length}</strong></div><div className="panel"><span>PENDING REVIEWS</span><strong>{rows.filter(item => !item.decision).length}</strong></div><div className="panel"><span>REPLACEMENT REVIEWS</span><strong>{rows.filter(item => item.action === 'EQUIPMENT_REPLACEMENT_REVIEW').length}</strong></div></div>
      <p className="recommendation-policy">Policy: {query.data?.policy.windowDays} days · {query.data?.policy.monitorAt}+ preventive maintenance · {query.data?.policy.investigateAt}+ investigation · {query.data?.policy.componentAt}+ component review when one component repeats · {query.data?.policy.replacementAt}+ equipment review. Confirmed episodes before the latest recorded unit replacement are excluded.</p>
      {rows.length ? <div className="recommendation-grid">{rows.map(item => <RecommendationCard key={`${item.deviceId}:${item.causeKey}`} item={item} canDecide={canDecide} />)}</div> : <div className="state-panel">No confirmed recurring cause evidence yet. Confirm a diagnosis in Fault diagnostics to generate a recommendation.</div>}
      <p className="recommendation-note">{query.data?.note} A 30-day cost estimate appears only after at least 7 observed days since commissioning or replacement; unknown values are shown explicitly.</p>
    </>}
  </>;
}
