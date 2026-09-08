-- Apply once to an existing deployment database.
-- The repository does not yet contain a baseline Prisma migration history.
ALTER TABLE "HubTransfer" ADD COLUMN "vehicleId" TEXT;

CREATE INDEX "HubTransfer_toHubId_transferredAt_idx"
ON "HubTransfer"("toHubId", "transferredAt");

ALTER TABLE "HubTransfer"
ADD CONSTRAINT "HubTransfer_vehicleId_fkey"
FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
