export function isHeartbeatFresh(value: string | null, now: number, timeoutMs: number): boolean {
  if (!value || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return false;
  const ageMs = now - new Date(value).getTime();
  return Number.isFinite(ageMs) && ageMs >= 0 && ageMs < timeoutMs;
}
