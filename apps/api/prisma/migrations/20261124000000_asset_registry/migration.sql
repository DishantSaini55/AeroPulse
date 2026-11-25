CREATE SCHEMA IF NOT EXISTS "public";

CREATE TYPE "DeviceRole" AS ENUM ('PRIMARY', 'SECONDARY');
CREATE TYPE "DeviceHealth" AS ENUM ('HEALTHY', 'DEGRADED', 'UNAVAILABLE', 'RECOVERING');
CREATE TYPE "ActivationState" AS ENUM ('ACTIVE', 'STANDBY', 'INELIGIBLE');
CREATE TYPE "ServiceAvailability" AS ENUM ('AVAILABLE', 'DEGRADED', 'OUTAGE');

CREATE TABLE "LogicalSystem" (
    "id" UUID NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "availability" "ServiceAvailability" NOT NULL DEFAULT 'AVAILABLE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "LogicalSystem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Device" (
    "id" UUID NOT NULL,
    "code" VARCHAR(48) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "systemId" UUID NOT NULL,
    "role" "DeviceRole" NOT NULL,
    "health" "DeviceHealth" NOT NULL DEFAULT 'HEALTHY',
    "activationState" "ActivationState" NOT NULL DEFAULT 'STANDBY',
    "commissionedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LogicalSystem_code_key" ON "LogicalSystem"("code");
CREATE UNIQUE INDEX "LogicalSystem_name_key" ON "LogicalSystem"("name");
CREATE UNIQUE INDEX "Device_code_key" ON "Device"("code");
CREATE INDEX "Device_systemId_activationState_idx" ON "Device"("systemId", "activationState");
CREATE UNIQUE INDEX "Device_systemId_role_key" ON "Device"("systemId", "role");
CREATE UNIQUE INDEX "Device_one_active_per_system" ON "Device"("systemId") WHERE "activationState" = 'ACTIVE';

ALTER TABLE "Device" ADD CONSTRAINT "Device_systemId_fkey" FOREIGN KEY ("systemId") REFERENCES "LogicalSystem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
