CREATE TYPE "AlarmLevel" AS ENUM ('INFORMATION', 'WARNING', 'MAJOR', 'CRITICAL');
CREATE TABLE "Alarm" (
  "id" UUID NOT NULL,
  "sourceKey" VARCHAR(120) NOT NULL,
  "diagnosisId" UUID,
  "deviceId" UUID NOT NULL,
  "level" "AlarmLevel" NOT NULL,
  "initialLevel" "AlarmLevel" NOT NULL,
  "message" VARCHAR(500) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMP(3),
  "simulated" BOOLEAN NOT NULL DEFAULT true,
  CONSTRAINT "Alarm_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "AlarmAcknowledgement" (
  "id" UUID NOT NULL,
  "alarmId" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "acknowledgedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AlarmAcknowledgement_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Alarm_sourceKey_key" ON "Alarm"("sourceKey");
CREATE UNIQUE INDEX "Alarm_diagnosisId_key" ON "Alarm"("diagnosisId");
CREATE INDEX "Alarm_resolvedAt_level_createdAt_idx" ON "Alarm"("resolvedAt", "level", "createdAt" DESC);
CREATE INDEX "Alarm_deviceId_createdAt_idx" ON "Alarm"("deviceId", "createdAt" DESC);
CREATE UNIQUE INDEX "AlarmAcknowledgement_alarmId_userId_key" ON "AlarmAcknowledgement"("alarmId", "userId");
CREATE INDEX "AlarmAcknowledgement_userId_acknowledgedAt_idx" ON "AlarmAcknowledgement"("userId", "acknowledgedAt" DESC);
ALTER TABLE "Alarm" ADD CONSTRAINT "Alarm_diagnosisId_fkey" FOREIGN KEY ("diagnosisId") REFERENCES "FaultDiagnosis"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Alarm" ADD CONSTRAINT "Alarm_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AlarmAcknowledgement" ADD CONSTRAINT "AlarmAcknowledgement_alarmId_fkey" FOREIGN KEY ("alarmId") REFERENCES "Alarm"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AlarmAcknowledgement" ADD CONSTRAINT "AlarmAcknowledgement_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
