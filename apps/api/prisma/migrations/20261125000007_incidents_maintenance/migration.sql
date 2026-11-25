CREATE TYPE "IncidentStatus" AS ENUM ('DETECTED', 'ACKNOWLEDGED', 'ASSIGNED', 'UNDER_INVESTIGATION', 'UNDER_REPAIR', 'VERIFICATION', 'RESOLVED');
CREATE TYPE "IncidentPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'URGENT');

CREATE TABLE "Incident" (
  "id" UUID NOT NULL,
  "alarmId" UUID NOT NULL,
  "deviceId" UUID NOT NULL,
  "status" "IncidentStatus" NOT NULL DEFAULT 'DETECTED',
  "priority" "IncidentPriority" NOT NULL,
  "description" VARCHAR(500) NOT NULL,
  "assignedToId" UUID,
  "approvedById" UUID,
  "approvedAt" TIMESTAMP(3),
  "resolvedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Incident_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "IncidentEvent" (
  "id" UUID NOT NULL,
  "incidentId" UUID NOT NULL,
  "actorId" UUID,
  "kind" VARCHAR(32) NOT NULL,
  "detail" VARCHAR(2000) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IncidentEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RepairRecord" (
  "id" UUID NOT NULL,
  "incidentId" UUID NOT NULL,
  "actorId" UUID NOT NULL,
  "action" VARCHAR(2000) NOT NULL,
  "spareParts" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "cost" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RepairRecord_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Incident_alarmId_key" ON "Incident"("alarmId");
CREATE INDEX "Incident_status_createdAt_idx" ON "Incident"("status", "createdAt" DESC);
CREATE INDEX "Incident_deviceId_createdAt_idx" ON "Incident"("deviceId", "createdAt" DESC);
CREATE INDEX "Incident_assignedToId_status_idx" ON "Incident"("assignedToId", "status");
CREATE INDEX "IncidentEvent_incidentId_createdAt_idx" ON "IncidentEvent"("incidentId", "createdAt");
CREATE INDEX "RepairRecord_incidentId_createdAt_idx" ON "RepairRecord"("incidentId", "createdAt");

ALTER TABLE "Incident" ADD CONSTRAINT "Incident_alarmId_fkey" FOREIGN KEY ("alarmId") REFERENCES "Alarm"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Incident" ADD CONSTRAINT "Incident_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Incident" ADD CONSTRAINT "Incident_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Incident" ADD CONSTRAINT "Incident_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "IncidentEvent" ADD CONSTRAINT "IncidentEvent_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "IncidentEvent" ADD CONSTRAINT "IncidentEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RepairRecord" ADD CONSTRAINT "RepairRecord_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RepairRecord" ADD CONSTRAINT "RepairRecord_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
