ALTER TABLE "FaultDiagnosis" ADD COLUMN "firstObservedAt" TIMESTAMP(3);
ALTER TABLE "Incident" ADD COLUMN "acknowledgedAt" TIMESTAMP(3);
