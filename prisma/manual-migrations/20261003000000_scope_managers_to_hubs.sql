-- Apply before deploying code that reads User.managedHubId.
-- Do not infer a hub from branch membership: branches may have multiple hubs.
-- An administrator must assign each existing manager explicitly.
BEGIN;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "managedHubId" TEXT;
CREATE INDEX IF NOT EXISTS "User_managedHubId_role_idx" ON "User"("managedHubId", "role");
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'User_managedHubId_fkey' AND conrelid = '"User"'::regclass) THEN
    ALTER TABLE "User" ADD CONSTRAINT "User_managedHubId_fkey"
      FOREIGN KEY ("managedHubId") REFERENCES "Hub"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
COMMIT;
