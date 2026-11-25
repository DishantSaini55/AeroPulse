CREATE TABLE "RecommendationDecision" (
  "id" UUID NOT NULL,
  "deviceId" UUID NOT NULL,
  "causeKey" VARCHAR(200) NOT NULL,
  "evidenceHash" CHAR(64) NOT NULL,
  "action" VARCHAR(40) NOT NULL,
  "decision" VARCHAR(16) NOT NULL,
  "note" VARCHAR(2000) NOT NULL,
  "decidedById" UUID NOT NULL,
  "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RecommendationDecision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RecommendationDecision_decision_check" CHECK ("decision" IN ('APPROVED', 'DECLINED'))
);
CREATE UNIQUE INDEX "RecommendationDecision_deviceId_causeKey_evidenceHash_key" ON "RecommendationDecision"("deviceId", "causeKey", "evidenceHash");
CREATE INDEX "RecommendationDecision_deviceId_decidedAt_idx" ON "RecommendationDecision"("deviceId", "decidedAt" DESC);
ALTER TABLE "RecommendationDecision" ADD CONSTRAINT "RecommendationDecision_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RecommendationDecision" ADD CONSTRAINT "RecommendationDecision_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
