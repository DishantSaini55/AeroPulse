/**
 * Optional notification transports.  They are intentionally inert until an
 * application wires them to a loopback collector: production configuration
 * must use a provider-specific transport, not these local verification hooks.
 */
export type LocalNotificationPayload = {
  recipient: string;
  subject: string;
  body: string;
  eventId: string;
};

function localOnlyEndpoint(value: string) {
  const endpoint = new URL(value);
  if (!['127.0.0.1', '::1', 'localhost'].includes(endpoint.hostname)) {
    throw new Error('Local notification adapters only permit loopback endpoints');
  }
  if (!['http:', 'https:'].includes(endpoint.protocol)) throw new Error('Local notification adapter endpoint must use HTTP(S)');
  return endpoint;
}

abstract class LocalHttpAdapter {
  private readonly endpoint: URL;
  protected abstract readonly channel: 'EMAIL' | 'WEB_PUSH';

  constructor(endpoint: string) { this.endpoint = localOnlyEndpoint(endpoint); }

  async deliver(payload: LocalNotificationPayload) {
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: this.channel, ...payload }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`${this.channel} local adapter returned HTTP ${response.status}`);
  }
}

/** Local collector adapter; it never contacts an SMTP server. */
export class LocalEmailAdapter extends LocalHttpAdapter { protected readonly channel = 'EMAIL' as const; }

/** Local collector adapter; it never contacts a browser push service. */
export class LocalWebPushAdapter extends LocalHttpAdapter { protected readonly channel = 'WEB_PUSH' as const; }
