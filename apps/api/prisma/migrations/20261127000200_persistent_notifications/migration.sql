CREATE TYPE "NotificationKind" AS ENUM ('ALARM_RAISED', 'INCIDENT_CHANGED', 'MAINTENANCE_ASSIGNED');
CREATE TYPE "NotificationPriority" AS ENUM ('INFORMATION', 'WARNING', 'MAJOR', 'CRITICAL');
CREATE TYPE "NotificationDeliveryStatus" AS ENUM ('PENDING', 'DELIVERED', 'FAILED', 'DISABLED');

CREATE TABLE "NotificationEvent" (
  "id" UUID NOT NULL,
  "sourceKey" VARCHAR(180) NOT NULL,
  "kind" "NotificationKind" NOT NULL,
  "priority" "NotificationPriority" NOT NULL DEFAULT 'INFORMATION',
  "title" VARCHAR(200) NOT NULL,
  "body" VARCHAR(2000) NOT NULL,
  "deviceId" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "NotificationEvent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "NotificationEvent_sourceKey_key" ON "NotificationEvent"("sourceKey");
CREATE INDEX "NotificationEvent_createdAt_idx" ON "NotificationEvent"("createdAt" DESC);
CREATE INDEX "NotificationEvent_deviceId_createdAt_idx" ON "NotificationEvent"("deviceId", "createdAt" DESC);

CREATE TABLE "NotificationRecipient" (
  "id" UUID NOT NULL,
  "eventId" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "readAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "NotificationRecipient_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "NotificationRecipient_eventId_userId_key" ON "NotificationRecipient"("eventId", "userId");
CREATE INDEX "NotificationRecipient_userId_readAt_createdAt_idx" ON "NotificationRecipient"("userId", "readAt", "createdAt" DESC);

CREATE TABLE "NotificationPreference" (
  "userId" UUID NOT NULL,
  "inAppEnabled" BOOLEAN NOT NULL DEFAULT true,
  "minimumPriority" "NotificationPriority" NOT NULL DEFAULT 'INFORMATION',
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("userId")
);

CREATE TABLE "NotificationDelivery" (
  "id" UUID NOT NULL,
  "recipientId" UUID NOT NULL,
  "channel" VARCHAR(24) NOT NULL DEFAULT 'IN_APP',
  "status" "NotificationDeliveryStatus" NOT NULL DEFAULT 'PENDING',
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastAttemptAt" TIMESTAMP(3),
  "deliveredAt" TIMESTAMP(3),
  "lastError" VARCHAR(500),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "NotificationDelivery_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "NotificationDelivery_recipientId_channel_key" ON "NotificationDelivery"("recipientId", "channel");
CREATE INDEX "NotificationDelivery_status_nextAttemptAt_idx" ON "NotificationDelivery"("status", "nextAttemptAt");

ALTER TABLE "NotificationEvent" ADD CONSTRAINT "NotificationEvent_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "NotificationRecipient" ADD CONSTRAINT "NotificationRecipient_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "NotificationEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NotificationRecipient" ADD CONSTRAINT "NotificationRecipient_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NotificationPreference" ADD CONSTRAINT "NotificationPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "NotificationRecipient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
