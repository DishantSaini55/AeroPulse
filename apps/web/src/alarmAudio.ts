export type AlarmLevel = 'INFORMATION' | 'WARNING' | 'MAJOR' | 'CRITICAL';

export type AudioPreferences = {
  soundEnabled: boolean;
  voiceEnabled: boolean;
  muted: boolean;
  masterVolume: number;
  voiceVolume: number;
  speechRate: number;
  voiceName: string;
  severities: Record<AlarmLevel, boolean>;
};

export type AnnouncementAlarm = {
  id: string;
  level: AlarmLevel;
  message: string;
  resolvedAt: string | null;
  acknowledged: boolean;
  device: { code: string; name: string; role?: string; system: { code: string; name: string; availability?: string } };
  diagnosis?: { suspectedCause?: string; confirmedRootCause?: string | null; component?: string; symptoms?: string[]; serviceImpact?: string; investigationSteps?: string[]; recoveryAction?: string } | null;
  failover?: { result: 'SUCCESS' | 'NO_HEALTHY_STANDBY' | 'BLOCKED'; toDevice?: { code: string; name?: string } | null } | null;
};

const storageKey = 'ap-alarm-preferences-v2';
export const defaultAudioPreferences: AudioPreferences = {
  soundEnabled: true, voiceEnabled: true, muted: false, masterVolume: 0.38, voiceVolume: 0.75, speechRate: 0.92, voiceName: '',
  severities: { INFORMATION: true, WARNING: true, MAJOR: true, CRITICAL: true },
};

export function loadAudioPreferences(): AudioPreferences {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return defaultAudioPreferences;
    const saved = JSON.parse(raw) as Partial<AudioPreferences>;
    return { ...defaultAudioPreferences, ...saved, severities: { ...defaultAudioPreferences.severities, ...saved.severities } };
  } catch { return defaultAudioPreferences; }
}

export function saveAudioPreferences(value: AudioPreferences) {
  localStorage.setItem(storageKey, JSON.stringify(value));
}

const priority: Record<AlarmLevel, number> = { INFORMATION: 1, WARNING: 2, MAJOR: 3, CRITICAL: 4 };
export const alarmPriority = (level: AlarmLevel) => priority[level];

export function buildVoiceAnnouncement(alarm: AnnouncementAlarm): string {
  const device = `${alarm.device.system.name} ${alarm.device.role?.toLowerCase() ?? ''} ${alarm.device.name}`.replace(/\s+/g, ' ').trim();
  const simulated = 'Simulation alert.';
  if (alarm.resolvedAt) return `${simulated} ${device} has recovered. ${alarm.diagnosis?.recoveryAction ?? 'Verify equipment stability before changing service assignment.'}`;
  if (alarm.failover?.result === 'SUCCESS') return `${simulated} ${alarm.device.system.name} backup device activated successfully. Service remains available. System redundancy is currently degraded.`;
  if (alarm.failover) return `${simulated} Critical ${alarm.device.system.name} service alert. No healthy standby activation was recorded. Immediate maintenance attention required.`;
  const cause = alarm.diagnosis?.confirmedRootCause ? `Confirmed cause: ${alarm.diagnosis.confirmedRootCause}.` : alarm.diagnosis?.suspectedCause ? `Possible cause: ${alarm.diagnosis.suspectedCause}.` : 'The cause is currently unknown.';
  const impact = alarm.diagnosis?.serviceImpact ?? (alarm.device.system.availability === 'OUTAGE' ? 'Simulated logical service is unavailable.' : 'Maintenance investigation is required.');
  const component = alarm.diagnosis?.component ? `Affected component may be ${alarm.diagnosis.component}.` : '';
  return `${simulated} ${alarm.level.toLowerCase()} alarm. ${device} fault detected. ${cause} ${component} ${impact} Maintenance personnel are requested to investigate.`.replace(/\s+/g, ' ').trim();
}

function tone(context: AudioContext, output: GainNode, frequency: number, start: number, duration: number, gain: number) {
  const oscillator = context.createOscillator();
  const envelope = context.createGain();
  oscillator.type = 'sine'; oscillator.frequency.value = frequency;
  envelope.gain.setValueAtTime(0.0001, start);
  envelope.gain.exponentialRampToValueAtTime(gain, start + 0.025);
  envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  oscillator.connect(envelope).connect(output); oscillator.start(start); oscillator.stop(start + duration + 0.02);
}

export class AlarmAudioManager {
  private context: AudioContext | null = null;
  private output: GainNode | null = null;
  private queue: AnnouncementAlarm[] = [];
  private seen = new Set<string>();
  private repeat: ReturnType<typeof setInterval> | null = null;
  private channel: BroadcastChannel | null = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('aeropulse-alarm-audio');

  constructor(private preferences: () => AudioPreferences) {
    this.channel?.addEventListener('message', event => { if (typeof event.data?.id === 'string') this.seen.add(event.data.id); });
  }

  get ready() { return this.context?.state === 'running'; }
  get voiceSupported() { return typeof speechSynthesis !== 'undefined' && typeof SpeechSynthesisUtterance !== 'undefined'; }
  voices() { return this.voiceSupported ? speechSynthesis.getVoices() : []; }

  async activate() {
    this.context ??= new AudioContext();
    await this.context.resume();
  }

  setPreferencesChanged() { if (this.output) this.output.gain.value = this.preferences().masterVolume; }

  enqueue(alarm: AnnouncementAlarm) {
    const prefs = this.preferences();
    const key = `${alarm.id}:${alarm.level}:${alarm.resolvedAt ?? 'active'}`;
    if (this.seen.has(key) || !prefs.severities[alarm.level]) return;
    this.seen.add(key); this.channel?.postMessage({ id: key });
    this.queue.push(alarm); this.queue.sort((a, b) => alarmPriority(b.level) - alarmPriority(a.level));
    if (alarm.level === 'CRITICAL' && this.voiceSupported) speechSynthesis.cancel();
    this.playNext();
  }

  private playNext() {
    const alarm = this.queue.shift();
    if (!alarm) return;
    const prefs = this.preferences();
    if (prefs.muted) return;
    if (prefs.soundEnabled && this.ready) this.playPattern(alarm.level);
    if (prefs.voiceEnabled && this.voiceSupported) {
      const utterance = new SpeechSynthesisUtterance(buildVoiceAnnouncement(alarm));
      utterance.volume = prefs.voiceVolume; utterance.rate = prefs.speechRate;
      const voice = this.voices().find(item => item.name === prefs.voiceName) ?? this.voices().find(item => /^en/i.test(item.lang) && /female|zira|samantha|aria/i.test(item.name)) ?? this.voices().find(item => /^en/i.test(item.lang));
      if (voice) utterance.voice = voice;
      utterance.onend = () => this.playNext(); utterance.onerror = () => this.playNext();
      speechSynthesis.speak(utterance);
    } else this.playNext();
  }

  playPattern(level: AlarmLevel) {
    if (!this.context) return;
    this.stopTone();
    const output = this.context.createGain(); output.gain.value = this.preferences().masterVolume; output.connect(this.context.destination); this.output = output;
    const play = () => {
      if (!this.context || !this.output) return;
      const start = this.context.currentTime;
      if (level === 'INFORMATION') tone(this.context, this.output, 660, start, 0.22, 0.12);
      if (level === 'WARNING') { tone(this.context, this.output, 620, start, 0.13, 0.12); tone(this.context, this.output, 620, start + 0.2, 0.13, 0.12); }
      if (level === 'MAJOR') { tone(this.context, this.output, 520, start, 0.2, 0.18); tone(this.context, this.output, 520, start + 0.32, 0.2, 0.18); }
      if (level === 'CRITICAL') { tone(this.context, this.output, 780, start, 0.18, 0.2); tone(this.context, this.output, 780, start + 0.28, 0.18, 0.2); tone(this.context, this.output, 780, start + 0.56, 0.18, 0.2); }
    };
    play();
    if (level === 'MAJOR' || level === 'CRITICAL') this.repeat = setInterval(play, level === 'CRITICAL' ? 8000 : 15000);
  }

  stopTone() { if (this.repeat) clearInterval(this.repeat); this.repeat = null; this.output?.disconnect(); this.output = null; }
  stopAll() { this.queue = []; this.stopTone(); if (this.voiceSupported) speechSynthesis.cancel(); }
  destroy() { this.stopAll(); this.channel?.close(); void this.context?.close(); this.context = null; }
}
