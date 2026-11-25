import type { Metrics } from '../simulator/generator.js';

export type DiagnosisRule = {
  ruleCode: string; suspectedCause: string; component: string; severity: 'WARNING' | 'MAJOR' | 'CRITICAL';
  symptoms: string[]; supportingTelemetry: Record<string, number>; investigationSteps: string[]; recoveryAction: string;
};

const threshold = (name: string, fallback: number) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
};

export function diagnosticThresholds() {
  return {
    temperatureC: threshold('DIAG_TEMPERATURE_C', 70), fanRpm: threshold('DIAG_FAN_RPM', 900),
    cpuPercent: threshold('DIAG_CPU_PERCENT', 85), memoryPercent: threshold('DIAG_MEMORY_PERCENT', 85),
    latencyMs: threshold('DIAG_LATENCY_MS', 120), packetLossPct: threshold('DIAG_PACKET_LOSS_PCT', 10),
    voltageV: threshold('DIAG_MIN_VOLTAGE_V', 190), diskPercent: threshold('DIAG_DISK_PERCENT', 90),
  };
}

export function diagnose(metrics: Metrics, heartbeatMissing: boolean, thresholds = diagnosticThresholds()): DiagnosisRule[] {
  const findings: DiagnosisRule[] = [];
  if (metrics.temperatureC != null && metrics.fanRpm != null && metrics.temperatureC >= thresholds.temperatureC && metrics.fanRpm <= thresholds.fanRpm) findings.push({
    ruleCode: 'COOLING_FAN', suspectedCause: 'Possible cooling fan malfunction', component: 'Cooling fan', severity: 'MAJOR',
    symptoms: ['High temperature', 'Low fan speed'], supportingTelemetry: { temperatureC: metrics.temperatureC, fanRpm: metrics.fanRpm },
    investigationSteps: ['Inspect fan and airflow', 'Check fan power and bearings'], recoveryAction: 'No automatic repair; inspect cooling assembly',
  });
  else if (metrics.temperatureC != null && metrics.temperatureC >= thresholds.temperatureC) findings.push({
    ruleCode: 'THERMAL_STRESS', suspectedCause: 'Possible overheating', component: 'Thermal management', severity: 'WARNING',
    symptoms: ['High temperature'], supportingTelemetry: { temperatureC: metrics.temperatureC },
    investigationSteps: ['Check ambient temperature and airflow', 'Inspect cooling equipment'], recoveryAction: 'No automatic repair; inspect thermal conditions',
  });
  if (metrics.cpuPercent != null && metrics.memoryPercent != null && metrics.cpuPercent >= thresholds.cpuPercent && metrics.memoryPercent >= thresholds.memoryPercent) findings.push({
    ruleCode: 'RESOURCE_OVERLOAD', suspectedCause: 'Possible resource overload', component: 'Compute resources', severity: 'MAJOR',
    symptoms: ['High CPU utilization', 'High memory utilization'], supportingTelemetry: { cpuPercent: metrics.cpuPercent, memoryPercent: metrics.memoryPercent },
    investigationSteps: ['Inspect running processes', 'Check workload and memory pressure'], recoveryAction: 'No automatic repair; review workload',
  });
  else if (metrics.memoryPercent != null && metrics.memoryPercent >= thresholds.memoryPercent) findings.push({
    ruleCode: 'MEMORY_PRESSURE', suspectedCause: 'Possible memory pressure', component: 'Memory', severity: 'WARNING',
    symptoms: ['High memory utilization'], supportingTelemetry: { memoryPercent: metrics.memoryPercent },
    investigationSteps: ['Inspect memory consumers', 'Check application logs'], recoveryAction: 'No automatic repair; review workload',
  });
  if (metrics.latencyMs != null && metrics.packetLossPct != null && metrics.latencyMs >= thresholds.latencyMs && metrics.packetLossPct >= thresholds.packetLossPct) findings.push({
    ruleCode: 'NETWORK_DEGRADATION', suspectedCause: 'Possible network degradation', component: 'Network path', severity: 'WARNING',
    symptoms: ['High latency', 'High packet loss'], supportingTelemetry: { latencyMs: metrics.latencyMs, packetLossPct: metrics.packetLossPct },
    investigationSteps: ['Inspect interfaces and cabling', 'Check upstream links'], recoveryAction: 'No automatic repair; investigate network path',
  });
  if (metrics.voltageV != null && metrics.voltageV <= thresholds.voltageV) findings.push({
    ruleCode: 'POWER_SUPPLY', suspectedCause: 'Possible power supply issue', component: 'Power supply', severity: 'MAJOR',
    symptoms: ['Low voltage'], supportingTelemetry: { voltageV: metrics.voltageV },
    investigationSteps: ['Measure input voltage', 'Inspect power connections'], recoveryAction: 'No automatic repair; inspect power source',
  });
  if (metrics.diskPercent != null && metrics.diskPercent >= thresholds.diskPercent) findings.push({
    ruleCode: 'STORAGE_PRESSURE', suspectedCause: 'Possible storage exhaustion', component: 'Storage', severity: 'WARNING',
    symptoms: ['High disk utilization'], supportingTelemetry: { diskPercent: metrics.diskPercent },
    investigationSteps: ['Inspect disk usage', 'Check application logs'], recoveryAction: 'No automatic repair; review storage usage',
  });
  if (heartbeatMissing) findings.push({
    ruleCode: 'MISSING_HEARTBEAT', suspectedCause: metrics.packetLossPct != null && metrics.packetLossPct >= thresholds.packetLossPct ? 'Possible connectivity failure' : 'Unknown cause of missing heartbeat',
    component: 'Device or network connection', severity: 'CRITICAL', symptoms: ['Missing heartbeat'], supportingTelemetry: metrics.packetLossPct == null ? {} : { packetLossPct: metrics.packetLossPct },
    investigationSteps: ['Check device power and connectivity', 'Inspect recent telemetry and network events'], recoveryAction: 'Redundancy manager may activate a healthy standby',
  });
  return findings;
}
