CREATE TABLE "FaultDiagnosis" (
  "id" UUID NOT NULL,
  "deviceId" UUID NOT NULL,
  "ruleCode" VARCHAR(64) NOT NULL,
  "suspectedCause" VARCHAR(250) NOT NULL,
  "component" VARCHAR(100) NOT NULL,
  "severity" VARCHAR(16) NOT NULL,
  "symptoms" JSONB NOT NULL,
  "supportingTelemetry" JSONB NOT NULL,
  "serviceImpact" VARCHAR(250) NOT NULL,
  "investigationSteps" JSONB NOT NULL,
  "recoveryAction" VARCHAR(250) NOT NULL,
  "detectedAt" TIMESTAMP(3) NOT NULL,
  "lastSeenAt" TIMESTAMP(3) NOT NULL,
  "resolvedAt" TIMESTAMP(3),
  "confirmedRootCause" VARCHAR(500),
  "confirmedById" UUID,
  "confirmedAt" TIMESTAMP(3),
  "simulated" BOOLEAN NOT NULL DEFAULT true,
  CONSTRAINT "FaultDiagnosis_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "FaultDiagnosis_deviceId_detectedAt_idx" ON "FaultDiagnosis"("deviceId", "detectedAt" DESC);
CREATE INDEX "FaultDiagnosis_resolvedAt_severity_idx" ON "FaultDiagnosis"("resolvedAt", "severity");
CREATE UNIQUE INDEX "FaultDiagnosis_one_active_rule_per_device" ON "FaultDiagnosis"("deviceId", "ruleCode") WHERE "resolvedAt" IS NULL;
ALTER TABLE "FaultDiagnosis" ADD CONSTRAINT "FaultDiagnosis_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FaultDiagnosis" ADD CONSTRAINT "FaultDiagnosis_confirmedById_fkey" FOREIGN KEY ("confirmedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
