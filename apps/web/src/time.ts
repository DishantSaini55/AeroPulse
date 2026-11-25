const dateTime = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
const timeWithSeconds = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
const timeWithoutSeconds = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

export const formatUtcDateTime = (value?: string | null) => value ? `${dateTime.format(new Date(value))} UTC` : '—';
export const formatUtcTime = (value: string | number, seconds = true) => `${(seconds ? timeWithSeconds : timeWithoutSeconds).format(new Date(value))} UTC`;
