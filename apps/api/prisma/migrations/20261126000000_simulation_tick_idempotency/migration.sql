-- A simulation slot is one five-second interval per device. These unique keys fence
-- duplicate writes during leader handoff without affecting distinct measurements.
CREATE UNIQUE INDEX "TelemetryReading_deviceId_recordedAt_key" ON "TelemetryReading"("deviceId", "recordedAt");
CREATE UNIQUE INDEX "Heartbeat_deviceId_recordedAt_key" ON "Heartbeat"("deviceId", "recordedAt");
