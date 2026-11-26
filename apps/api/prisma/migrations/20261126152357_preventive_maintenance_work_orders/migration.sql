-- CreateEnum
CREATE TYPE "MaintenanceFrequency" AS ENUM ('DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'HALF_YEARLY', 'YEARLY', 'CUSTOM');

-- CreateEnum
CREATE TYPE "WorkOrderType" AS ENUM ('PREVENTIVE', 'CORRECTIVE', 'INSPECTION', 'COMPONENT_REPLACEMENT', 'EQUIPMENT_REPLACEMENT');

-- CreateEnum
CREATE TYPE "WorkOrderPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "WorkOrderStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'ASSIGNED', 'IN_PROGRESS', 'VERIFICATION', 'COMPLETED', 'ON_HOLD', 'CANCELLED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ChecklistResult" AS ENUM ('PASSED', 'FAILED', 'NOT_APPLICABLE');

-- AlterEnum
ALTER TYPE "FailoverAction" ADD VALUE 'PLANNED_MAINTENANCE';

-- CreateTable
CREATE TABLE "MaintenancePlan" (
    "id" UUID NOT NULL,
    "name" VARCHAR(140) NOT NULL,
    "deviceId" UUID NOT NULL,
    "systemId" UUID NOT NULL,
    "category" VARCHAR(100) NOT NULL,
    "description" VARCHAR(2000) NOT NULL,
    "checklist" JSONB NOT NULL,
    "frequency" "MaintenanceFrequency" NOT NULL,
    "customIntervalDays" INTEGER,
    "advanceNoticeDays" INTEGER NOT NULL DEFAULT 7,
    "estimatedDurationMinutes" INTEGER NOT NULL,
    "priority" "WorkOrderPriority" NOT NULL DEFAULT 'MEDIUM',
    "assignedEngineerId" UUID,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastCompletedAt" TIMESTAMP(3),
    "nextScheduledAt" TIMESTAMP(3) NOT NULL,
    "createdById" UUID NOT NULL,
    "updatedById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MaintenancePlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaintenanceWorkOrder" (
    "id" UUID NOT NULL,
    "occurrenceKey" VARCHAR(180) NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "deviceId" UUID NOT NULL,
    "systemId" UUID NOT NULL,
    "planId" UUID,
    "incidentId" UUID,
    "type" "WorkOrderType" NOT NULL,
    "priority" "WorkOrderPriority" NOT NULL,
    "description" VARCHAR(2000) NOT NULL,
    "status" "WorkOrderStatus" NOT NULL DEFAULT 'DRAFT',
    "assignedEngineerId" UUID,
    "supervisorId" UUID,
    "scheduledStartAt" TIMESTAMP(3),
    "scheduledCompletionAt" TIMESTAMP(3),
    "actualStartAt" TIMESTAMP(3),
    "actualCompletionAt" TIMESTAMP(3),
    "estimatedDurationMinutes" INTEGER NOT NULL,
    "estimatedCost" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "laborCost" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "otherCost" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "findings" VARCHAR(4000),
    "verificationResult" VARCHAR(4000),
    "maintenanceModeAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cancellationReason" VARCHAR(1000),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MaintenanceWorkOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkOrderChecklistItem" (
    "id" UUID NOT NULL,
    "workOrderId" UUID NOT NULL,
    "description" VARCHAR(500) NOT NULL,
    "completed" BOOLEAN NOT NULL DEFAULT false,
    "result" "ChecklistResult",
    "remarks" VARCHAR(2000),
    "completedAt" TIMESTAMP(3),
    "completedById" UUID,

    CONSTRAINT "WorkOrderChecklistItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkOrderStatusHistory" (
    "id" UUID NOT NULL,
    "workOrderId" UUID NOT NULL,
    "fromStatus" "WorkOrderStatus",
    "toStatus" "WorkOrderStatus" NOT NULL,
    "actorId" UUID NOT NULL,
    "note" VARCHAR(2000),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkOrderStatusHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkOrderPartUsage" (
    "id" UUID NOT NULL,
    "workOrderId" UUID NOT NULL,
    "partName" VARCHAR(200) NOT NULL,
    "partNumber" VARCHAR(100),
    "quantity" INTEGER NOT NULL,
    "unitCost" DECIMAL(12,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkOrderPartUsage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MaintenancePlan_active_nextScheduledAt_idx" ON "MaintenancePlan"("active", "nextScheduledAt");

-- CreateIndex
CREATE INDEX "MaintenancePlan_deviceId_active_idx" ON "MaintenancePlan"("deviceId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "MaintenanceWorkOrder_occurrenceKey_key" ON "MaintenanceWorkOrder"("occurrenceKey");

-- CreateIndex
CREATE INDEX "MaintenanceWorkOrder_status_scheduledStartAt_idx" ON "MaintenanceWorkOrder"("status", "scheduledStartAt");

-- CreateIndex
CREATE INDEX "MaintenanceWorkOrder_deviceId_status_idx" ON "MaintenanceWorkOrder"("deviceId", "status");

-- CreateIndex
CREATE INDEX "MaintenanceWorkOrder_systemId_status_idx" ON "MaintenanceWorkOrder"("systemId", "status");

-- CreateIndex
CREATE INDEX "MaintenanceWorkOrder_assignedEngineerId_status_idx" ON "MaintenanceWorkOrder"("assignedEngineerId", "status");

-- CreateIndex
CREATE INDEX "WorkOrderChecklistItem_workOrderId_completed_idx" ON "WorkOrderChecklistItem"("workOrderId", "completed");

-- CreateIndex
CREATE INDEX "WorkOrderStatusHistory_workOrderId_createdAt_idx" ON "WorkOrderStatusHistory"("workOrderId", "createdAt");

-- CreateIndex
CREATE INDEX "WorkOrderPartUsage_workOrderId_idx" ON "WorkOrderPartUsage"("workOrderId");

-- AddForeignKey
ALTER TABLE "MaintenancePlan" ADD CONSTRAINT "MaintenancePlan_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenancePlan" ADD CONSTRAINT "MaintenancePlan_systemId_fkey" FOREIGN KEY ("systemId") REFERENCES "LogicalSystem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenancePlan" ADD CONSTRAINT "MaintenancePlan_assignedEngineerId_fkey" FOREIGN KEY ("assignedEngineerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenancePlan" ADD CONSTRAINT "MaintenancePlan_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenancePlan" ADD CONSTRAINT "MaintenancePlan_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenanceWorkOrder" ADD CONSTRAINT "MaintenanceWorkOrder_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenanceWorkOrder" ADD CONSTRAINT "MaintenanceWorkOrder_systemId_fkey" FOREIGN KEY ("systemId") REFERENCES "LogicalSystem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenanceWorkOrder" ADD CONSTRAINT "MaintenanceWorkOrder_planId_fkey" FOREIGN KEY ("planId") REFERENCES "MaintenancePlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenanceWorkOrder" ADD CONSTRAINT "MaintenanceWorkOrder_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenanceWorkOrder" ADD CONSTRAINT "MaintenanceWorkOrder_assignedEngineerId_fkey" FOREIGN KEY ("assignedEngineerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenanceWorkOrder" ADD CONSTRAINT "MaintenanceWorkOrder_supervisorId_fkey" FOREIGN KEY ("supervisorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkOrderChecklistItem" ADD CONSTRAINT "WorkOrderChecklistItem_workOrderId_fkey" FOREIGN KEY ("workOrderId") REFERENCES "MaintenanceWorkOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkOrderChecklistItem" ADD CONSTRAINT "WorkOrderChecklistItem_completedById_fkey" FOREIGN KEY ("completedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkOrderStatusHistory" ADD CONSTRAINT "WorkOrderStatusHistory_workOrderId_fkey" FOREIGN KEY ("workOrderId") REFERENCES "MaintenanceWorkOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkOrderStatusHistory" ADD CONSTRAINT "WorkOrderStatusHistory_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkOrderPartUsage" ADD CONSTRAINT "WorkOrderPartUsage_workOrderId_fkey" FOREIGN KEY ("workOrderId") REFERENCES "MaintenanceWorkOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
