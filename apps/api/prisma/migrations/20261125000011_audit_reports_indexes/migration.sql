CREATE TABLE "AuditEvent" (
  "id" UUID NOT NULL,
  "actorId" UUID NOT NULL,
  "actorRole" "UserRole" NOT NULL,
  "method" VARCHAR(8) NOT NULL,
  "path" VARCHAR(300) NOT NULL,
  "statusCode" INTEGER NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AuditEvent_occurredAt_idx" ON "AuditEvent"("occurredAt" DESC);
CREATE INDEX "AuditEvent_actorId_occurredAt_idx" ON "AuditEvent"("actorId", "occurredAt" DESC);
CREATE INDEX "AuditEvent_statusCode_occurredAt_idx" ON "AuditEvent"("statusCode", "occurredAt" DESC);
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "FaultDiagnosis_detectedAt_idx" ON "FaultDiagnosis"("detectedAt" DESC);
CREATE INDEX "Incident_createdAt_idx" ON "Incident"("createdAt" DESC);
CREATE INDEX "RepairRecord_createdAt_idx" ON "RepairRecord"("createdAt" DESC);
CREATE INDEX "DeviceReplacement_replacedAt_idx" ON "DeviceReplacement"("replacedAt" DESC);
