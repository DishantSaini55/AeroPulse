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
  operationalNotice?: true;
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
  if (alarm.operationalNotice) return `Simulation notice. ${alarm.message}`;
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
  private speaking: SpeechSynthesisUtterance | null = null;
  private speakingLevel: AlarmLevel | null = null;
  private repeatLevel: AlarmLevel | null = null;
  private channel: BroadcastChannel | null;

  constructor(private preferences: () => AudioPreferences, private readonly scope = 'local') {
    this.channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('aeropulse-alarm-audio:' + scope);
    try { this.seen = new Set(JSON.parse(sessionStorage.getItem('ap-audio-seen:' + scope) ?? '[]') as string[]); } catch { /* Browser storage can be unavailable. */ }
    this.channel?.addEventListener('message', event => { if (typeof event.data?.id === 'string') this.remember(event.data.id); });
  }

  private remember(key: string) {
    this.seen.add(key);
    if (this.seen.size > 1000) this.seen.delete(this.seen.values().next().value!);
    try { sessionStorage.setItem('ap-audio-seen:' + this.scope, JSON.stringify([...this.seen])); } catch { /* Local deduplication still works. */ }
  }

  get ready() { return this.context?.state === 'running'; }
  get voiceSupported() { return typeof speechSynthesis !== 'undefined' && typeof SpeechSynthesisUtterance !== 'undefined'; }
  voices() { return this.voiceSupported ? speechSynthesis.getVoices() : []; }

  async activate() {
    this.context ??= new AudioContext();
    await this.context.resume();
    this.playNext();
  }

  setPreferencesChanged() { if (this.output) this.output.gain.value = this.preferences().masterVolume; }

  enqueue(alarm: AnnouncementAlarm) {
    const prefs = this.preferences();
    const key = `${alarm.id}:${alarm.level}:${alarm.resolvedAt ?? 'active'}`;
    if (this.seen.has(key) || !prefs.severities[alarm.level]) return;
    this.remember(key); this.channel?.postMessage({ id: key });
    if (prefs.muted) return;
    this.queue.push(alarm); this.queue.sort((a, b) => alarmPriority(b.level) - alarmPriority(a.level));
    if (this.queue.length > 50) this.queue.pop();
    if (alarm.level === 'CRITICAL' && this.speaking && this.speakingLevel !== 'CRITICAL' && this.voiceSupported) {
      this.speaking = null; this.speakingLevel = null; speechSynthesis.cancel();
    }
    this.playNext();
  }

  private playNext() {
    if (!this.ready || this.speaking) return;
    const alarm = this.queue.shift();
    if (!alarm) return;
    const prefs = this.preferences();
    if (prefs.muted) return;
    if (prefs.soundEnabled && (!this.repeatLevel || alarmPriority(alarm.level) >= alarmPriority(this.repeatLevel))) this.playPattern(alarm.level);
    if (prefs.voiceEnabled && this.voiceSupported) {
      const utterance = new SpeechSynthesisUtterance(buildVoiceAnnouncement(alarm));
      utterance.volume = prefs.voiceVolume; utterance.rate = prefs.speechRate;
      const voice = this.voices().find(item => item.name === prefs.voiceName) ?? this.voices().find(item => /^en/i.test(item.lang) && /female|zira|samantha|aria/i.test(item.name)) ?? this.voices().find(item => /^en/i.test(item.lang));
      if (voice) utterance.voice = voice;
      this.speaking = utterance; this.speakingLevel = alarm.level;
      const done = () => { if (this.speaking !== utterance) return; this.speaking = null; this.speakingLevel = null; this.playNext(); };
      utterance.onend = done; utterance.onerror = done;
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
    if (level === 'MAJOR' || level === 'CRITICAL') { this.repeatLevel = level; this.repeat = setInterval(play, level === 'CRITICAL' ? 8000 : 15000); }
  }

  reconcileActiveAlarms(alarms: Pick<AnnouncementAlarm, 'level' | 'acknowledged' | 'resolvedAt'>[]) {
    if (this.repeatLevel && !alarms.some(alarm => alarm.level === this.repeatLevel && !alarm.resolvedAt && !alarm.acknowledged)) this.stopTone();
  }
  stopTone() { if (this.repeat) clearInterval(this.repeat); this.repeat = null; this.repeatLevel = null; this.output?.disconnect(); this.output = null; }
  stopAll() { this.queue = []; this.speaking = null; this.speakingLevel = null; this.stopTone(); if (this.voiceSupported) speechSynthesis.cancel(); }
  destroy() { this.stopAll(); this.channel?.close(); void this.context?.close(); this.context = null; }
}
