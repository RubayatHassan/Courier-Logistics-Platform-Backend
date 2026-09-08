-- Apply once to an existing deployment database.
-- The repository does not yet contain a baseline Prisma migration history.
ALTER TYPE "ParcelStatus" ADD VALUE IF NOT EXISTS 'IN_TRANSIT';

ALTER TABLE "HubTransfer" ADD COLUMN IF NOT EXISTS "vehicleId" TEXT;

CREATE INDEX IF NOT EXISTS "HubTransfer_toHubId_transferredAt_idx"
ON "HubTransfer"("toHubId", "transferredAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'HubTransfer_vehicleId_fkey'
  ) THEN
    ALTER TABLE "HubTransfer"
      ADD CONSTRAINT "HubTransfer_vehicleId_fkey"
      FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
