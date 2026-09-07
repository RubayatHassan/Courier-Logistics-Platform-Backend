import bcrypt from "bcryptjs";
import { env } from "../src/config/env.js";
import { prisma } from "../src/infrastructure/prisma.js";

const passwordHash = await bcrypt.hash("Password123!", env.BCRYPT_SALT_ROUNDS);
for (const [name, description] of [
  ["SUPER_ADMIN", "Platform super administrator"],
  ["ADMIN", "Platform administrator"],
  ["MERCHANT", "Merchant operator"],
  ["RIDER", "Delivery rider"],
] as const)
  await prisma.roleRecord.upsert({
    where: { name },
    update: { description },
    create: { name, description },
  });
const merchant = await prisma.merchant.upsert({
  where: { slug: "demo-merchant" },
  update: {},
  create: {
    name: "Demo Merchant",
    slug: "demo-merchant",
    email: "merchant@example.com",
    phone: "01700000000",
  },
});
await prisma.user.upsert({
  where: { email: "admin@example.com" },
  update: {},
  create: {
    email: "admin@example.com",
    name: "Platform Admin",
    role: "ADMIN",
    passwordHash,
    emailVerifiedAt: new Date(),
  },
});
await prisma.user.upsert({
  where: { email: "merchant@example.com" },
  update: {},
  create: {
    email: "merchant@example.com",
    name: "Demo Merchant",
    role: "MERCHANT",
    merchantId: merchant.id,
    passwordHash,
    emailVerifiedAt: new Date(),
  },
});
const hub = await prisma.hub.upsert({
  where: { code: "DHK-01" },
  update: {},
  create: {
    name: "Dhaka Central Hub",
    code: "DHK-01",
    address: "Motijheel, Dhaka",
    city: "Dhaka",
  },
});
const riderUser = await prisma.user.upsert({
  where: { email: "rider@example.com" },
  update: {},
  create: {
    email: "rider@example.com",
    name: "Demo Rider",
    role: "RIDER",
    passwordHash,
    emailVerifiedAt: new Date(),
  },
});
await prisma.rider.upsert({
  where: { userId: riderUser.id },
  update: {},
  create: { userId: riderUser.id, hubId: hub.id, vehicleType: "Motorbike" },
});
console.log({ merchant: merchant.slug, demoPassword: "Password123!" });
await prisma.$disconnect();
