import { app } from "./app.js";
import { env } from "./app/config/env.js";
import { prisma } from "./app/lib/prisma.js";
import { connectRedis } from "./app/lib/redis.js";
import { hashPassword } from "./app/middleware/auth.js";

async function ensureSuperAdmin() {
  if (!env.SUPER_ADMIN_EMAIL || !env.SUPER_ADMIN_PASSWORD) return;
  const passwordHash = await hashPassword(env.SUPER_ADMIN_PASSWORD);
  await prisma.user.upsert({
    where: { email: env.SUPER_ADMIN_EMAIL },
    update: { role: "SUPER_ADMIN", emailVerifiedAt: new Date() },
    create: {
      email: env.SUPER_ADMIN_EMAIL,
      name: "Platform Super Admin",
      role: "SUPER_ADMIN",
      passwordHash,
      emailVerifiedAt: new Date(),
    },
  });
}

try {
  await connectRedis();
} catch (error) {
  console.warn(
    "Redis unavailable; cache is disabled and protected authentication actions will return 503. Check REDIS_URL and Redis availability.",
    error,
  );
}
try {
  await ensureSuperAdmin();
} catch (error) {
  console.warn("Super admin bootstrap skipped; database unavailable", error);
}
app.listen(env.PORT, () =>
  console.log(`Courier platform API listening on port ${env.PORT}`),
);
