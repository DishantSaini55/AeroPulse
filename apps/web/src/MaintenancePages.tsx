import { useState, type FormEvent, type ReactNode } from 'react';
import { NavLink, useNavigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from './auth';
import { maintenanceRequest as api, useOptionsQuery, orderStatuses, orderTypes, type Plan, type WorkOrder, type Overview, type Costs, type Readiness, type Part, type Options } from './maintenanceApi';
import { formatUtcDateTime as stamp } from './time';
import './maintenance.css';

const label = (text: string) => text.replaceAll('_', ' ');
const money = (value: number | string) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(Number(value));
const duration = (value: number | null) => value == null ? 'Unavailable' : (value / 3600000).toFixed(2) + ' hours';
const day = (offset: number) => new Date(Date.now() + offset * 86400000).toISOString().slice(0,10);
const final = (order: WorkOrder) => ['COMPLETED','CANCELLED'].includes(order.status);
function State({ loading, error }: { loading: boolean; error: Error | null }) { return loading ? <p role="status">Loading maintenance data…</p> : error ? <p className="form-error" role="alert">{error.message}</p> : null; }
function Shell({ title, children }: { title: string; children: ReactNode }) {
  return <div className="maintenance-workspace"><div className="page-heading"><span className="eyebrow">SIMULATED OPERATIONS / MAINTENANCE</span><h1>{title}</h1><p>Database-backed work orders. All schedules and history use UTC.</p></div>
    <nav className="maintenance-tabs" aria-label="Maintenance navigation">{[['/maintenance','Overview'],['/maintenance/plans','Plans'],['/maintenance/orders','Work orders'],['/maintenance/calendar','Calendar'],['/maintenance/records','Incident & repair history']].map(([path,text]) => <NavLink key={path} end={path === '/maintenance'} to={path}>{text}</NavLink>)}</nav>{children}</div>;
}
function useAction() {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  const run = async (path: string, method: string, body?: unknown) => {
    setBusy(true); setError(''); setMessage('');
    try { const value = await api<{ data: unknown }>(path, method, body); setMessage('Saved. Authoritative state refreshed.'); return value; }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Request failed'); throw cause; }
    finally { setBusy(false); for (const key of ['maintenance','snapshot','redundancy','failover-events','analytics']) void client.invalidateQueries({ queryKey: [key] }); }
  };
  return { busy, error, message, run };
}
function Feedback({ action }: { action: ReturnType<typeof useAction> }) { return <><span role="status" className="maintenance-feedback">{action.message}</span>{action.error && <div className="form-error" role="alert">{action.error}</div>}</>; }
function Range({ from, to, setFrom, setTo }: { from: string; to: string; setFrom: (value: string) => void; setTo: (value: string) => void }) {
  return <div className="toolbar"><label>From (UTC)<input type="date" value={from} onChange={event => setFrom(event.target.value)} required /></label><label>Through (UTC)<input type="date" value={to} onChange={event => setTo(event.target.value)} required /></label></div>;
}
export function MaintenanceOverviewPage() {
  const [from,setFrom] = useState(day(-30)), [to,setTo] = useState(day(30));
  const query = useQuery({ queryKey: ['maintenance','overview',from,to], queryFn: async () => (await api<{ data: Overview }>(`overview?from=${from}&to=${to}`)).data, refetchInterval: 15000 });
  const data = query.data;
  return <Shell title="Maintenance overview"><Range {...{ from,to,setFrom,setTo }} /><State loading={query.isPending} error={query.error} />{data && <>
    <div className="maintenance-metrics">{[['Upcoming orders',data.upcoming],['Overdue orders',data.overdue],['Upcoming plans',data.upcomingPlans],['Overdue plans',data.overduePlans],['Active orders',data.active],['Completed',data.completed],['Devices in maintenance',data.devicesUnderMaintenance],['Expenditure',money(data.totalExpenditure)]].map(([name,value]) => <div className="small-metric" key={name}><span>{name}</span><strong>{value}</strong></div>)}</div>
    <div className="maintenance-grid"><section className="panel maintenance-pad"><h2>Compliance and reliability</h2><dl><dt>On-time preventive compliance</dt><dd>{data.compliance.percent == null ? 'Unavailable — no due orders' : data.compliance.percent.toFixed(1) + '%'} ({data.compliance.numerator}/{data.compliance.denominator})</dd><dt>Average completion time</dt><dd>{duration(data.averageCompletionMs)} · {data.completionSamples} samples</dd><dt>Planned equipment downtime</dt><dd>{duration(data.plannedEquipmentDowntimeMs)}</dd><dt>Unplanned equipment downtime</dt><dd>{duration(data.unplannedEquipmentDowntimeMs)}</dd><dt>Observed service availability</dt><dd>{data.serviceAvailabilityPct == null ? 'Unavailable — insufficient observations' : data.serviceAvailabilityPct.toFixed(3) + '%'} · {duration(data.serviceObservedMs)} observed</dd><dt>Order distribution</dt><dd>Preventive {data.distribution.preventive} / Corrective {data.distribution.corrective} / Other {data.distribution.other}</dd></dl></section>
    <section className="panel maintenance-pad maintenance-workload" tabIndex={0} aria-label="Engineer workload"><h2>Engineer workload</h2>{data.engineerWorkload.length ? <table><thead><tr><th>Engineer</th><th>Active</th><th>Completed</th></tr></thead><tbody>{data.engineerWorkload.map(row => <tr key={row.id}><td>{row.name}</td><td>{row.active}</td><td>{row.completed}</td></tr>)}</tbody></table> : <p>No assigned orders in this range.</p>}</section>
    {[['Equipment expenditure',data.expenditureByDevice],['Logical system expenditure',data.expenditureBySystem]].map(([title,rows]) => <section className="panel maintenance-pad" key={String(title)}><h2>{String(title)}</h2>{(rows as Overview['expenditureByDevice']).length ? <table><thead><tr><th>Resource</th><th>Amount</th></tr></thead><tbody>{(rows as Overview['expenditureByDevice']).map(row => <tr key={row.code}><td>{row.code}</td><td>{money(row.amount)}</td></tr>)}</tbody></table> : <p>No expenditure records.</p>}</section>)}</div>
    <details className="panel maintenance-pad"><summary>Calculation definitions and denominators</summary>{Object.entries(data.formulas).map(([name,text]) => <p key={name}><strong>{label(name)}:</strong> {text}</p>)}<p>Devices undergoing maintenance is a current registry count. Other cards use the selected order cohort. Last computed {stamp(data.generatedAt)}.</p></details>
  </>}</Shell>;
}
export function MaintenancePlansPage() {
  const query = useQuery({ queryKey: ['maintenance','plans'], queryFn: async () => (await api<{ data: Plan[] }>('plans')).data });
  const options = useQuery(useOptionsQuery), { user } = useAuth(), action = useAction();
  const manage = user?.role !== 'MAINTENANCE_ENGINEER';
  return <Shell title="Maintenance plans"><div className="toolbar">{manage && <NavLink className="primary-button" to="/maintenance/plans/new">Create plan</NavLink>}</div><State loading={query.isPending || options.isPending} error={query.error || options.error} /><Feedback action={action} /><div className="table-wrap"><table><thead><tr><th>Plan / equipment</th><th>Recurrence</th><th>Next UTC schedule</th><th>Engineer</th><th>Status</th><th>Actions</th></tr></thead><tbody>{query.data?.map(plan => <tr key={plan.id}><td>{plan.name}<div className="sub-cell">{options.data?.devices.find(device => device.id === plan.deviceId)?.code}</div></td><td>{label(plan.frequency)} {plan.frequency === 'CUSTOM' && `/ ${plan.customIntervalDays} days`}</td><td>{stamp(plan.nextScheduledAt)}</td><td>{options.data?.engineers.find(engineer => engineer.id === plan.assignedEngineerId)?.name ?? 'Unassigned'}</td><td>{plan.active ? 'Active' : 'Inactive'}</td><td>{manage && <><NavLink className="text-link" to={'/maintenance/plans/' + plan.id + '/edit'}>Edit</NavLink> <button disabled={action.busy} onClick={() => void action.run('plans/' + plan.id, 'PATCH', { active: !plan.active }).catch(() => {})}>{plan.active ? 'Deactivate' : 'Activate'}</button></>}</td></tr>)}</tbody></table>{query.data?.length === 0 && <p className="maintenance-pad">No plans. Create a plan to schedule recurring work.</p>}</div></Shell>;
}
export function MaintenancePlanForm() {
  const { id } = useParams(), navigate = useNavigate(), { user } = useAuth();
  const options = useQuery(useOptionsQuery);
  const query = useQuery({ queryKey: ['maintenance','plan',id], queryFn: async () => (await api<{ data: Plan }>('plans/' + id)).data, enabled: !!id });
  if (user?.role === 'MAINTENANCE_ENGINEER') return <Shell title="Plan authorization"><p className="form-error">Supervisor access required.</p></Shell>;
  return <Shell title={id ? 'Edit maintenance plan' : 'Create maintenance plan'}><State loading={options.isPending || (!!id && query.isPending)} error={options.error || query.error} />{options.data && (!id || query.data) && <PlanEditor key={id ?? 'new'} plan={query.data} options={options.data} done={() => navigate('/maintenance/plans')} />}</Shell>;
}
function PlanEditor({ plan, options, done }: { plan?: Plan; options: Options; done: () => void }) {
  const action = useAction();
  const [frequency,setFrequency] = useState(plan?.frequency ?? 'MONTHLY');
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    const body = { name: form.get('name'), deviceId: form.get('deviceId'), category: form.get('category'), description: form.get('description'),
      checklist: String(form.get('checklist')).split('\n').map(value => value.trim()).filter(Boolean), frequency,
      customIntervalDays: frequency === 'CUSTOM' ? Number(form.get('customIntervalDays')) : undefined, advanceNoticeDays: Number(form.get('advanceNoticeDays')),
      estimatedDurationMinutes: Number(form.get('duration')), priority: form.get('priority'), assignedEngineerId: form.get('engineer') || (plan ? null : undefined) };
    try { await action.run(plan ? 'plans/' + plan.id : 'plans', plan ? 'PATCH' : 'POST', body); done(); } catch {}
  };
  return <form className="panel maintenance-form" onSubmit={event => void submit(event)}><div className="maintenance-grid">
    <label>Plan name<input name="name" required minLength={3} maxLength={140} defaultValue={plan?.name} /></label>
    <label>Device<select name="deviceId" defaultValue={plan?.deviceId} required>{options.devices.map(device => <option key={device.id} value={device.id}>{device.code} · {device.name}</option>)}</select></label>
    <label>Category<input name="category" required minLength={3} maxLength={100} defaultValue={plan?.category ?? 'Inspection'} /></label>
    <label>Engineer<select name="engineer" defaultValue={plan?.assignedEngineerId ?? ''}><option value="">Unassigned</option>{options.engineers.map(engineer => <option key={engineer.id} value={engineer.id}>{engineer.name}</option>)}</select></label>
    <label>Frequency<select value={frequency} onChange={event => setFrequency(event.target.value)}>{['DAILY','WEEKLY','MONTHLY','QUARTERLY','HALF_YEARLY','YEARLY','CUSTOM'].map(value => <option key={value}>{value}</option>)}</select></label>
    {frequency === 'CUSTOM' && <label>Custom interval (days)<input name="customIntervalDays" required type="number" min={1} max={3650} defaultValue={plan?.customIntervalDays ?? 30} /></label>}
    <label>Advance notice (days)<input name="advanceNoticeDays" type="number" min={0} max={365} required defaultValue={plan?.advanceNoticeDays ?? 7} /></label>
    <label>Duration (minutes)<input name="duration" type="number" min={1} max={10080} required defaultValue={plan?.estimatedDurationMinutes ?? 60} /></label>
    <label>Priority<select name="priority" defaultValue={plan?.priority ?? 'MEDIUM'}>{['LOW','MEDIUM','HIGH','URGENT'].map(value => <option key={value}>{value}</option>)}</select></label></div>
    <label>Description<textarea name="description" required minLength={3} maxLength={2000} defaultValue={plan?.description} /></label>
    <label>Checklist template — one task per line<textarea name="checklist" required defaultValue={plan?.checklist.join('\n')} rows={5} /></label>
    <p className="muted">Template edits affect future occurrences. Existing work-order checklists remain historical snapshots. Editing recurrence preserves the next due date.</p>
    <div className="toolbar"><button className="primary-button" disabled={action.busy}>Save plan</button><NavLink to="/maintenance/plans">Cancel</NavLink></div><Feedback action={action} /></form>;
}
export function WorkOrdersPage({ device }: { device?: string }) {
  const [search,setSearch] = useState(''), [status,setStatus] = useState(''), [type,setType] = useState(''), [sort,setSort] = useState('created'), [direction,setDirection] = useState('desc'), [page,setPage] = useState(1);
  const { user } = useAuth();
  const params = new URLSearchParams({ search,sort,direction,page:String(page),limit:'20' }); if (status) params.set('status',status); if (type) params.set('type',type); if (device) params.set('device',device);
  const query = useQuery({ queryKey: ['maintenance','orders',params.toString()], queryFn: () => api<{ data: WorkOrder[]; total: number; page: number; limit: number }>('workspace/orders?' + params), refetchInterval: 15000 });
  const update = (fn: (value: string) => void, value: string) => { fn(value); setPage(1); };
  const table = <><div className="toolbar"><label>Search<input aria-label="Search work orders" value={search} onChange={event => update(setSearch,event.target.value)} placeholder="Title, description or device" /></label>
    <label>Status<select value={status} onChange={event => update(setStatus,event.target.value)}><option value="">All statuses</option>{orderStatuses.map(value => <option key={value}>{value}</option>)}</select></label>
    <label>Type<select value={type} onChange={event => update(setType,event.target.value)}><option value="">All types</option>{orderTypes.map(value => <option key={value}>{value}</option>)}</select></label>
    <label>Sort<select value={sort} onChange={event => update(setSort,event.target.value)}><option value="created">Creation</option><option value="scheduled">Scheduled UTC time</option><option value="priority">Priority</option></select></label>
    <label>Direction<select value={direction} onChange={event => update(setDirection,event.target.value)}><option value="desc">Descending</option><option value="asc">Ascending</option></select></label>
    {user?.role !== 'MAINTENANCE_ENGINEER' && <NavLink className="primary-button" to="/maintenance/orders/new">Create work order</NavLink>}</div>
    <State loading={query.isPending} error={query.error} /><div className="table-wrap"><table><thead><tr><th>Work order</th><th>Device</th><th>Status / priority</th><th>Engineer</th><th>Scheduled UTC</th><th>Type</th></tr></thead><tbody>{query.data?.data.map(order => <tr key={order.id}><td><NavLink className="text-link" to={'/maintenance/orders/' + order.id}>{order.title}</NavLink></td><td>{order.device?.code}</td><td>{label(order.status)} / {order.priority}</td><td>{order.assignedEngineer?.name ?? 'Unassigned'}</td><td>{stamp(order.scheduledStartAt)}</td><td>{label(order.type)}</td></tr>)}</tbody></table>{query.data?.total === 0 && <p className="maintenance-pad">No matching work orders.</p>}</div>
    <div className="toolbar maintenance-pagination"><button disabled={page === 1} onClick={() => setPage(value => value-1)}>Previous</button><span>Page {page} · {query.data?.total ?? 0} records</span><button disabled={page*20 >= (query.data?.total ?? 0)} onClick={() => setPage(value => value+1)}>Next</button></div></>;
  return device ? <section className="maintenance-workspace"><h2>{device} work-order history</h2>{table}</section> : <Shell title="Work orders">{table}</Shell>;
}
export function ManualWorkOrderPage() {
  const options = useQuery(useOptionsQuery), { user } = useAuth(), navigate = useNavigate(), action = useAction();
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = new FormData(event.currentTarget); const utc = String(form.get('scheduled'));
    try { const result = await action.run('work-orders','POST',{ title: form.get('title'), deviceId: form.get('device'), type: form.get('type'), priority: form.get('priority'), description: form.get('description'), estimatedDurationMinutes: Number(form.get('duration')), scheduledStartAt: utc ? utc + ':00.000Z' : undefined }); navigate('/maintenance/orders/' + (result.data as WorkOrder).id); } catch {}
  };
  return <Shell title="Create manual work order">{user?.role === 'MAINTENANCE_ENGINEER' ? <p className="form-error">Supervisor access required.</p> : <><State loading={options.isPending} error={options.error} />{options.data && <form className="panel maintenance-form" onSubmit={event => void submit(event)}>
    <label>Title<input name="title" minLength={3} maxLength={200} required /></label><label>Device<select name="device" required>{options.data.devices.map(device => <option key={device.id} value={device.id}>{device.code}</option>)}</select></label>
    <div className="maintenance-grid"><label>Type<select name="type">{orderTypes.filter(type => type !== 'PREVENTIVE').map(type => <option key={type}>{type}</option>)}</select></label><label>Priority<select name="priority" defaultValue="MEDIUM">{['LOW','MEDIUM','HIGH','URGENT'].map(value => <option key={value}>{value}</option>)}</select></label><label>Duration (minutes)<input name="duration" type="number" min={1} max={10080} required defaultValue={60} /></label><label>Scheduled start (UTC, optional)<input name="scheduled" type="datetime-local" /></label></div>
    <label>Description<textarea name="description" required minLength={3} maxLength={2000} /></label><p className="muted">An unscheduled order starts as a draft. Assign an engineer before beginning maintenance.</p><button className="primary-button" disabled={action.busy}>Create work order</button><Feedback action={action} /></form>}</>}</Shell>;
}

export function WorkOrderDetailPage() {
  const { id = '' } = useParams(), { user } = useAuth(), action = useAction();
  const options = useQuery(useOptionsQuery);
  const query = useQuery({ queryKey: ['maintenance','order',id], queryFn: async () => (await api<{ data: WorkOrder }>('work-orders/' + id)).data, refetchInterval: 15000 });
  const costs = useQuery({ queryKey: ['maintenance','costs',id], queryFn: async () => (await api<{ data: Costs }>('work-orders/' + id + '/costs')).data });
  const readiness = useQuery({ queryKey: ['maintenance','readiness',id], queryFn: async () => (await api<{ data: Readiness }>('work-orders/' + id + '/readiness')).data, refetchInterval: 5000 });
  const history = useQuery({ queryKey: ['maintenance','history',id], queryFn: async () => (await api<{ data: { id: string; fromStatus: string | null; toStatus: string; note: string | null; createdAt: string; actor: { name: string } }[] }>('work-orders/' + id + '/history')).data });
  const order = query.data, manager = !!user && user.role !== 'MAINTENANCE_ENGINEER';
  const editable = !!order && !final(order) && !!user && (manager || user.id === order.assignedEngineerId);
  const path = 'work-orders/' + id;
  const submit = (suffix: string, method: string, body: unknown) => void action.run(path + suffix, method, body).catch(() => {});
  const start = () => {
    const message = readiness.data?.plannedSwitch ? `This simulated action will switch service to ${readiness.data.standbyCode} and make the current device maintenance-ineligible. Continue?` : 'Begin simulated maintenance? This device will remain activation-ineligible until verification and supervisor approval.';
    if (window.confirm(message)) submit('/start','POST',{});
  };
  return <Shell title={order?.title ?? 'Work order'}><NavLink className="text-link" to="/maintenance/orders">Back to work orders</NavLink><State loading={query.isPending || options.isPending} error={query.error || options.error} /><Feedback action={action} />{order && <>
    <section className="panel maintenance-pad"><span className="badge badge-blue">{label(order.status)}</span> <span className="badge badge-neutral">{order.priority} · {label(order.type)}</span><p>{order.description}</p>
      <dl><dt>Work-order identifier</dt><dd className="mono">{order.id}</dd><dt>Device</dt><dd><NavLink className="text-link" to={'/devices/' + options.data?.devices.find(device => device.id === order.deviceId)?.code}>{options.data?.devices.find(device => device.id === order.deviceId)?.code ?? order.deviceId}</NavLink></dd><dt>Assigned engineer</dt><dd>{options.data?.engineers.find(engineer => engineer.id === order.assignedEngineerId)?.name ?? 'Unassigned or inactive engineer'}</dd><dt>Scheduled / actual start (UTC)</dt><dd>{stamp(order.scheduledStartAt)} / {stamp(order.actualStartAt)}</dd><dt>Completed (UTC)</dt><dd>{stamp(order.completedAt)}</dd></dl>
      {final(order) && <p className="maintenance-note">This work order is finalized and immutable.</p>}
      {!editable && !final(order) && <p className="maintenance-note">Read-only: only the assigned engineer or a supervisor may change this work order.</p>}
    </section>
    <section className="panel maintenance-pad"><h2>Maintenance eligibility and redundancy</h2><State loading={readiness.isPending} error={readiness.error} />{readiness.data && <>
      <p>Readiness preview at {stamp(readiness.data.checkedAt)}. Every start revalidates and locks current equipment state on the server.</p>
      {readiness.data.blockingReasons.length > 0 && <ul>{readiness.data.blockingReasons.map(reason => <li key={reason}>{reason}</li>)}</ul>}
      <div className="table-wrap"><table><thead><tr><th>Device</th><th>Role / assignment</th><th>Health</th><th>Maintenance / eligibility</th><th>Heartbeat UTC</th><th>Freshness</th></tr></thead><tbody>{readiness.data.devices.map(device => <tr key={device.id}><td>{device.code}</td><td>{device.role} / {device.activationState}</td><td>{device.health}</td><td>{device.maintenanceStatus} / {device.maintenanceEligible ? 'Eligible' : 'Ineligible'}</td><td>{stamp(device.latestHeartbeatAt)}</td><td>{device.heartbeatFresh ? 'Fresh' : 'Stale or missing'} / {readiness.data.policy.timeoutMs/1000}s threshold</td></tr>)}</tbody></table></div>
      <button className="primary-button" disabled={!readiness.data.canStart || action.busy} onClick={start}>{readiness.data.plannedSwitch ? 'Confirm planned failover and start' : 'Begin authorized maintenance'}</button></>}</section>
    {manager && !final(order) && !order.maintenanceModeAt && <section className="panel maintenance-pad"><h2>Assignment and cancellation</h2><div className="maintenance-grid">
      <form onSubmit={event => { event.preventDefault(); submit('/assign','POST',{ engineerId: new FormData(event.currentTarget).get('engineer') }); }}><label>Assign engineer<select name="engineer" defaultValue={order.assignedEngineerId ?? ''} required><option value="" disabled>Select engineer</option>{options.data?.engineers.map(engineer => <option key={engineer.id} value={engineer.id}>{engineer.name}</option>)}</select></label><button disabled={action.busy || !['DRAFT','SCHEDULED'].includes(order.status)}>Assign engineer</button></form>
      <form onSubmit={event => { event.preventDefault(); if (window.confirm('Cancel this simulated work order?')) submit('/cancel','POST',{ reason: new FormData(event.currentTarget).get('reason') }); }}><label>Cancellation reason<input name="reason" required minLength={3} maxLength={1000} /></label><button disabled={action.busy}>Cancel work order</button></form></div></section>}
    <div className="maintenance-grid"><section className="panel maintenance-pad"><h2>Checklist snapshot</h2>{order.checklistItems?.length ? order.checklistItems.map(item => <form className="maintenance-checklist" data-checklist-id={item.id} key={item.id + item.completedAt} onSubmit={event => { event.preventDefault(); const form = new FormData(event.currentTarget); submit('/checklist/' + item.id,'PATCH',{ result: form.get('result'), remarks: form.get('remarks') }); }}>
      <strong>{item.description}</strong><fieldset disabled={!editable || action.busy}><label>Result<select name="result" defaultValue={item.result ?? ''} required><option value="" disabled>Not completed</option>{['PASSED','FAILED','NOT_APPLICABLE'].map(result => <option key={result}>{result}</option>)}</select></label><label>Checklist remarks<textarea name="remarks" maxLength={2000} defaultValue={item.remarks ?? ''} /></label><button>Save checklist result</button></fieldset><small>Recorded {stamp(item.completedAt)}</small></form>) : <p>No checklist tasks configured for this work order.</p>}</section>
    <section className="panel maintenance-pad"><h2>Maintenance findings</h2><form onSubmit={event => { event.preventDefault(); submit('/findings','PATCH',{ findings: new FormData(event.currentTarget).get('findings') }); }}><fieldset disabled={!editable || action.busy}><label>Findings<textarea name="findings" required minLength={3} maxLength={4000} defaultValue={order.findings ?? ''} rows={6} /></label><button>Save findings</button></fieldset></form>
    <h2>Authoritative costs</h2><State loading={costs.isPending} error={costs.error} />{costs.data && <dl><dt>Spare parts</dt><dd>{money(costs.data.parts)}</dd><dt>Labor</dt><dd>{money(costs.data.labor)}</dd><dt>Other</dt><dd>{money(costs.data.other)}</dd><dt>Total</dt><dd>{money(costs.data.total)}</dd></dl>}
    <form onSubmit={event => { event.preventDefault(); const form = new FormData(event.currentTarget); submit('/costs','PATCH',{ laborCost: Number(form.get('labor')), otherCost: Number(form.get('other')) }); }}><fieldset disabled={!editable || action.busy}><label>Labor cost (INR)<input name="labor" type="number" min={0} max={9999999999.99} step="0.01" required defaultValue={order.laborCost} /></label><label>Other cost (INR)<input name="other" type="number" min={0} max={9999999999.99} step="0.01" required defaultValue={order.otherCost} /></label><button>Save labor and other costs</button></fieldset></form></section></div>
    <section className="panel maintenance-pad"><h2>Spare parts</h2>{order.parts?.map(part => <PartEditor key={part.id} part={part} disabled={!editable || action.busy} save={body => submit('/parts/' + part.id,'PATCH',body)} remove={() => { if (window.confirm('Delete this part usage record?')) submit('/parts/' + part.id,'DELETE',undefined); }} />)}
      {editable && <PartEditor disabled={action.busy} save={body => submit('/parts','POST',body)} />}</section>
    <section className="panel maintenance-pad"><h2>Verification and supervisor decision</h2><p>{order.verificationResult ?? 'No verification evidence recorded.'}</p><div className="maintenance-grid"><form onSubmit={event => { event.preventDefault(); const form = new FormData(event.currentTarget); submit('/verify','POST',{ passed: form.get('passed') === 'true', remarks: form.get('remarks') }); }}><fieldset disabled={!editable || action.busy || !order.maintenanceModeAt || !['ASSIGNED','IN_PROGRESS','ON_HOLD'].includes(order.status)}><label>Verification outcome<select name="passed"><option value="true">Passed</option><option value="false">Failed — retain ineligibility</option></select></label><label>Verification evidence<textarea name="remarks" minLength={3} maxLength={4000} required /></label><button>Submit verification</button></fieldset></form>
    {manager && <div><button disabled={action.busy || order.status !== 'VERIFICATION' || !order.maintenanceModeAt} onClick={() => { if (window.confirm('Approve verified maintenance and restore safe standby eligibility?')) submit('/approve','POST',{}); }}>Approve and complete maintenance</button>
      {!order.maintenanceModeAt && <p className="muted">Completion requires work started through the authorized maintenance path.</p>}
      <form onSubmit={event => { event.preventDefault(); submit('/reject','POST',{ reason: new FormData(event.currentTarget).get('reason') }); }}><fieldset disabled={action.busy || order.status !== 'VERIFICATION'}><label>Supervisor rejection reason<textarea name="reason" required minLength={3} maxLength={1000} /></label><button>Reject verification</button></fieldset></form></div>}</div></section>
    <section className="panel maintenance-pad"><h2>Immutable status history</h2><State loading={history.isPending} error={history.error} /><div className="table-wrap"><table><thead><tr><th>UTC timestamp</th><th>Transition</th><th>Actor</th><th>Note</th></tr></thead><tbody>{history.data?.map(event => <tr key={event.id}><td>{stamp(event.createdAt)}</td><td>{event.fromStatus ?? 'Created'} → {event.toStatus}</td><td>{event.actor.name}</td><td className="maintenance-wrap">{event.note}</td></tr>)}</tbody></table></div></section>
  </>}</Shell>;
}
function PartEditor({ part, disabled, save, remove }: { part?: Part; disabled: boolean; save: (body: unknown) => void; remove?: () => void }) {
  return <form className="maintenance-part" onSubmit={event => { event.preventDefault(); const form = new FormData(event.currentTarget); save({ partName: form.get('name'), partNumber: String(form.get('number') ?? ''), quantity: Number(form.get('quantity')), unitCost: Number(form.get('cost')) }); }}><fieldset disabled={disabled}><legend>{part ? 'Recorded part' : 'Add spare part'}</legend><div className="maintenance-part-fields">
    <label>Part name<input name="name" required maxLength={200} defaultValue={part?.partName} /></label><label>Part number<input name="number" maxLength={100} defaultValue={part?.partNumber ?? ''} /></label><label>Quantity<input name="quantity" type="number" min={1} max={10000} required defaultValue={part?.quantity ?? 1} /></label><label>Unit cost (INR)<input name="cost" type="number" min={0} max={10000000} step="0.01" required defaultValue={part?.unitCost ?? '0.00'} /></label></div><button>{part ? 'Update part' : 'Add part'}</button> {remove && <button type="button" onClick={remove}>Delete part</button>}</fieldset></form>;
}
export function MaintenanceCalendarPage() {
  const [from,setFrom] = useState(day(-7)), [to,setTo] = useState(day(30));
  const query = useQuery({ queryKey: ['maintenance','calendar',from,to], queryFn: async () => (await api<{ data: { orders: WorkOrder[]; plans: (Plan & { device: { code: string }; assignedEngineer: { name: string } | null })[]; truncated: boolean } }>(`calendar?from=${from}&to=${to}`)).data, refetchInterval: 15000 });
  const orders = query.data?.orders ?? [];
  const conflicts = (order: WorkOrder) => orders.filter(other => other.id !== order.id && other.systemId === order.systemId && other.status !== 'COMPLETED' && order.status !== 'COMPLETED' &&
    new Date(other.scheduledStartAt!).getTime() < new Date(order.scheduledCompletionAt ?? new Date(new Date(order.scheduledStartAt!).getTime()+order.estimatedDurationMinutes*60000)).getTime() &&
    new Date(order.scheduledStartAt!).getTime() < new Date(other.scheduledCompletionAt ?? new Date(new Date(other.scheduledStartAt!).getTime()+other.estimatedDurationMinutes*60000)).getTime());
  return <Shell title="Maintenance calendar / UTC timeline"><Range {...{ from,to,setFrom,setTo }} /><State loading={query.isPending} error={query.error} />
    {query.data?.truncated && <p role="alert" className="form-error">Timeline limited to 500 plans and 500 orders. Narrow the selected range.</p>}
    <section className="panel maintenance-pad"><h2>Scheduled work orders</h2><p>Potential overlaps are advisory; every start is checked transactionally by the backend.</p><div className="table-wrap"><table><thead><tr><th>Scheduled UTC</th><th>Work order / device</th><th>Engineer</th><th>State</th><th>Potential conflicts</th></tr></thead><tbody>{orders.map(order => <tr key={order.id}><td>{stamp(order.scheduledStartAt)}</td><td><NavLink className="text-link" to={'/maintenance/orders/' + order.id}>{order.title}</NavLink><div>{order.device?.code}</div></td><td>{order.assignedEngineer?.name ?? 'Unassigned'}</td><td>{label(order.status)}{!final(order) && new Date(order.scheduledCompletionAt ?? order.scheduledStartAt!) < new Date() ? ' · Overdue' : ''}</td><td>{conflicts(order).length ? conflicts(order).map(other => <NavLink key={other.id} className="text-link" to={'/maintenance/orders/' + other.id}>{other.title} </NavLink>) : 'None in loaded range'}</td></tr>)}</tbody></table>{orders.length === 0 && <p>No scheduled work orders in this range.</p>}</div></section>
    <section className="panel maintenance-pad"><h2>Next recurring plan occurrences</h2><div className="table-wrap"><table><thead><tr><th>Next due UTC</th><th>Plan</th><th>Device</th><th>Engineer</th></tr></thead><tbody>{query.data?.plans.map(plan => <tr key={plan.id}><td>{stamp(plan.nextScheduledAt)}{new Date(plan.nextScheduledAt) < new Date() && ' · Overdue'}</td><td>{plan.name}</td><td>{plan.device.code}</td><td>{plan.assignedEngineer?.name ?? 'Unassigned'}</td></tr>)}</tbody></table></div></section></Shell>;
}
