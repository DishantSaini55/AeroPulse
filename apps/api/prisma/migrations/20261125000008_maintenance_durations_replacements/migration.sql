ALTER TABLE "Incident" ADD COLUMN "repairStartedAt" TIMESTAMP(3), ADD COLUMN "repairCompletedAt" TIMESTAMP(3);

CREATE TABLE "DeviceReplacement" (
  "id" UUID NOT NULL,
  "deviceId" UUID NOT NULL,
  "incidentId" UUID,
  "oldUnitSerial" VARCHAR(100) NOT NULL,
  "newUnitSerial" VARCHAR(100) NOT NULL,
  "reason" VARCHAR(2000) NOT NULL,
  "cost" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "authorizedById" UUID NOT NULL,
  "replacedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DeviceReplacement_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DeviceReplacement_deviceId_newUnitSerial_key" ON "DeviceReplacement"("deviceId", "newUnitSerial");
CREATE INDEX "DeviceReplacement_deviceId_replacedAt_idx" ON "DeviceReplacement"("deviceId", "replacedAt" DESC);
ALTER TABLE "DeviceReplacement" ADD CONSTRAINT "DeviceReplacement_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DeviceReplacement" ADD CONSTRAINT "DeviceReplacement_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DeviceReplacement" ADD CONSTRAINT "DeviceReplacement_authorizedById_fkey" FOREIGN KEY ("authorizedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
