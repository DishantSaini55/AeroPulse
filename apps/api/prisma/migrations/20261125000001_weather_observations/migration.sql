CREATE TABLE "WeatherObservation" (
    "id" UUID NOT NULL,
    "station" VARCHAR(4) NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    "rawMetar" TEXT NOT NULL,
    "temperatureC" DOUBLE PRECISION,
    "dewPointC" DOUBLE PRECISION,
    "visibilityMiles" DOUBLE PRECISION,
    "windSpeedKnots" DOUBLE PRECISION,
    "windDirectionDeg" INTEGER,
    "pressureHpa" DOUBLE PRECISION,
    "conditions" VARCHAR(120),
    CONSTRAINT "WeatherObservation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WeatherObservation_station_observedAt_key" ON "WeatherObservation"("station", "observedAt");
CREATE INDEX "WeatherObservation_station_fetchedAt_idx" ON "WeatherObservation"("station", "fetchedAt" DESC);
