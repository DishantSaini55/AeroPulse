CREATE TABLE "TelemetryReading" (
    "id" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "temperatureC" DOUBLE PRECISION,
    "cpuPercent" DOUBLE PRECISION,
    "memoryPercent" DOUBLE PRECISION,
    "diskPercent" DOUBLE PRECISION,
    "latencyMs" DOUBLE PRECISION,
    "packetLossPct" DOUBLE PRECISION,
    "voltageV" DOUBLE PRECISION,
    "currentA" DOUBLE PRECISION,
    "fanRpm" DOUBLE PRECISION,
    "batteryPct" DOUBLE PRECISION,
    "signalPct" DOUBLE PRECISION,
    "simulated" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "TelemetryReading_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Heartbeat" (
    "id" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "simulated" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "Heartbeat_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TelemetryReading_deviceId_recordedAt_idx" ON "TelemetryReading"("deviceId", "recordedAt" DESC);
CREATE INDEX "TelemetryReading_recordedAt_idx" ON "TelemetryReading"("recordedAt");
CREATE INDEX "Heartbeat_deviceId_recordedAt_idx" ON "Heartbeat"("deviceId", "recordedAt" DESC);
CREATE INDEX "Heartbeat_recordedAt_idx" ON "Heartbeat"("recordedAt");

ALTER TABLE "TelemetryReading" ADD CONSTRAINT "TelemetryReading_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Heartbeat" ADD CONSTRAINT "Heartbeat_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
