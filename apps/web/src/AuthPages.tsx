import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Antenna, ArrowRight, RefreshCw, ShieldCheck, UserPlus } from 'lucide-react';
import { createUser, getUsers, updateUser } from './api';
import { useAuth, type UserRole } from './auth';

const roles: { value: UserRole; label: string }[] = [
  { value: 'ADMINISTRATOR', label: 'Administrator' },
  { value: 'SUPERVISOR', label: 'Supervisor' },
  { value: 'MAINTENANCE_ENGINEER', label: 'Maintenance engineer' },
];
const labelFor = (role: UserRole) => roles.find(item => item.value === role)?.label ?? role;

export function LoginPage() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try { await login(email.trim(), password); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Sign in failed'); }
    finally { setBusy(false); }
  }
  return <main className="auth-screen">
    <div className="auth-intro"><div className="auth-brand"><span className="brand-mark"><Antenna size={20} /></span><strong>AeroPulse</strong></div><span className="eyebrow">INDEPENDENT SIMULATION</span><h1>Infrastructure<br />operations console</h1><p>Secure access to simulated airport systems, device telemetry, and public aviation weather.</p><div className="auth-caption"><ShieldCheck size={17} /> Local training environment</div></div>
    <section className="auth-card"><span className="eyebrow">ACCOUNT ACCESS</span><h2>Sign in</h2><p>Use the account created by your administrator.</p><form onSubmit={submit}>
      <label>Email address<input type="email" autoComplete="username" required maxLength={254} value={email} onChange={event => setEmail(event.target.value)} placeholder="you@example.com" /></label>
      <label>Password<input type="password" autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)} placeholder="Enter your password" /></label>
      {error && <div className="form-error" role="alert">{error}</div>}
      <button className="primary-button" type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}{busy ? <RefreshCw className="spin" size={16} /> : <ArrowRight size={16} />}</button>
    </form><div className="auth-card-foot">AeroPulse is a portfolio simulation. It is not connected to operational systems.</div></section>
  </main>;
}

export function UsersPage() {
  const { user } = useAuth();
  const client = useQueryClient();
  const users = useQuery({ queryKey: ['users'], queryFn: getUsers });
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<UserRole>('MAINTENANCE_ENGINEER');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const create = useMutation({ mutationFn: createUser, onSuccess: () => { void client.invalidateQueries({ queryKey: ['users'] }); setEmail(''); setName(''); setPassword(''); setRole('MAINTENANCE_ENGINEER'); setSuccess('Account created. Share the password securely with the user.'); } });
  const update = useMutation({ mutationFn: ({ id, change }: { id: string; change: { active?: boolean; role?: UserRole } }) => updateUser(id, change), onSuccess: () => { void client.invalidateQueries({ queryKey: ['users'] }); setSuccess('Account updated.'); } });
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); setSuccess('');
    try { await create.mutateAsync({ email: email.trim(), name: name.trim(), password, role }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not create account'); }
  }
  async function changeUser(id: string, change: { active?: boolean; role?: UserRole }) {
    setError(''); setSuccess('');
    try { await update.mutateAsync({ id, change }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not update account'); }
  }
  return <>
    <div className="page-heading"><span className="eyebrow">ADMINISTRATION / ACCESS</span><h1>User management</h1><p>Create accounts, assign roles, and disable access. Your own administrator role and active state are protected.</p></div>
    {error && <div className="form-error users-message" role="alert">{error}</div>}{success && <div className="form-success users-message" role="status">{success}</div>}
    <div className="users-layout"><section className="panel"><div className="panel-head"><div><span className="eyebrow">ACCESS REGISTER</span><h2>Accounts</h2></div><span className="muted">{users.data?.length ?? 0} users</span></div>
      {users.isPending ? <div className="state-panel">Loading accounts…</div> : users.error ? <div className="state-panel state-error">{users.error.message}</div> : <div className="user-list">{users.data?.map(item => <div className="user-row" key={item.id}><div className="user-info"><strong>{item.name}{item.id === user?.id && <small> YOU</small>}</strong><span>{item.email}</span></div><div className="user-controls"><select aria-label={`Role for ${item.name}`} value={item.role} disabled={item.id === user?.id || update.isPending} onChange={event => void changeUser(item.id, { role: event.target.value as UserRole })}>{roles.map(option => <option value={option.value} key={option.value}>{option.label}</option>)}</select><button className={item.active ? 'status-button active' : 'status-button'} disabled={item.id === user?.id || update.isPending} onClick={() => void changeUser(item.id, { active: !item.active })}>{item.active ? 'Active' : 'Disabled'}</button></div></div>)}</div>}</section>
      <section className="panel create-user"><div className="panel-head"><div><span className="eyebrow">NEW ACCOUNT</span><h2><UserPlus size={17} /> Create user</h2></div></div><form onSubmit={submit}><label>Full name<input required minLength={2} maxLength={120} value={name} onChange={event => setName(event.target.value)} /></label><label>Email address<input required type="email" autoComplete="off" maxLength={254} value={email} onChange={event => setEmail(event.target.value)} /></label><label>Temporary password<input required type="password" autoComplete="new-password" minLength={12} maxLength={72} value={password} onChange={event => setPassword(event.target.value)} /><small>12–72 UTF-8 bytes. Share it outside this console.</small></label><label>Role<select value={role} onChange={event => setRole(event.target.value as UserRole)}>{roles.map(option => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label><button className="primary-button" disabled={create.isPending} type="submit">{create.isPending ? 'Creating…' : 'Create account'} <ArrowRight size={16} /></button></form></section></div>
    <p className="table-note">Roles: {roles.map(item => labelFor(item.value)).join(' · ')}. Only administrators can manage accounts or create operations notes.</p>
  </>;
}
