CREATE TYPE "EquipmentMaintenance" AS ENUM ('AVAILABLE', 'IN_PROGRESS', 'AWAITING_APPROVAL');
ALTER TABLE "Device"
  ADD COLUMN "maintenanceStatus" "EquipmentMaintenance" NOT NULL DEFAULT 'AVAILABLE',
  ADD COLUMN "maintenanceEligible" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Device" ADD CONSTRAINT "device_active_maintenance_safe"
  CHECK ("activationState" <> 'ACTIVE' OR ("maintenanceEligible" AND "maintenanceStatus" = 'AVAILABLE'));
