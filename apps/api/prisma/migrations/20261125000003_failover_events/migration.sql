CREATE TYPE "FailoverAction" AS ENUM ('AUTOMATIC_FAILOVER', 'MANUAL_FAILBACK');
CREATE TYPE "FailoverResult" AS ENUM ('SUCCESS', 'NO_HEALTHY_STANDBY', 'BLOCKED');

CREATE TABLE "FailoverEvent" (
  "id" UUID NOT NULL,
  "systemId" UUID NOT NULL,
  "fromDeviceId" UUID,
  "toDeviceId" UUID,
  "initiatedById" UUID,
  "action" "FailoverAction" NOT NULL,
  "result" "FailoverResult" NOT NULL,
  "reason" VARCHAR(300) NOT NULL,
  "detectedAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3) NOT NULL,
  "durationMs" INTEGER NOT NULL,
  "simulated" BOOLEAN NOT NULL DEFAULT true,
  CONSTRAINT "FailoverEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "FailoverEvent_systemId_detectedAt_idx" ON "FailoverEvent"("systemId", "detectedAt" DESC);
CREATE INDEX "FailoverEvent_result_detectedAt_idx" ON "FailoverEvent"("result", "detectedAt" DESC);
ALTER TABLE "FailoverEvent" ADD CONSTRAINT "FailoverEvent_systemId_fkey" FOREIGN KEY ("systemId") REFERENCES "LogicalSystem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FailoverEvent" ADD CONSTRAINT "FailoverEvent_fromDeviceId_fkey" FOREIGN KEY ("fromDeviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FailoverEvent" ADD CONSTRAINT "FailoverEvent_toDeviceId_fkey" FOREIGN KEY ("toDeviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FailoverEvent" ADD CONSTRAINT "FailoverEvent_initiatedById_fkey" FOREIGN KEY ("initiatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
