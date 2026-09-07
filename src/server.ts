import { app } from "./app.js";
import { env } from "./config/env.js";
import { connectRedis } from "./infrastructure/redis.js";
import { prisma } from "./infrastructure/prisma.js";
import { hashPassword } from "./middleware/auth.js";

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
  console.warn("Redis unavailable; continuing without cache", error);
}
try {
  await ensureSuperAdmin();
} catch (error) {
  console.warn("Super admin bootstrap skipped; database unavailable", error);
}
app.listen(env.PORT, () =>
  console.log(`Courier platform API listening on port ${env.PORT}`),
);
