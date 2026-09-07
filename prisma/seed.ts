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
const branch = await prisma.warehouseBranch.upsert({
  where: { code: "DHK-BR-01" },
  update: { name: "Dhaka Operations Branch", isActive: true },
  create: {
    name: "Dhaka Operations Branch",
    code: "DHK-BR-01",
    type: "HUB",
    addressId: null,
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
  update: { branchId: branch.id, isActive: true },
  create: {
    name: "Dhaka Central Hub",
    code: "DHK-01",
    address: "Motijheel, Dhaka",
    city: "Dhaka",
    branchId: branch.id,
  },
});
const destinationHub = await prisma.hub.upsert({
  where: { code: "DHK-02" },
  update: { branchId: branch.id, isActive: true },
  create: {
    name: "Dhaka North Hub",
    code: "DHK-02",
    address: "Uttara, Dhaka",
    city: "Dhaka",
    branchId: branch.id,
  },
});
const vehicle = await prisma.vehicle.upsert({
  where: { plateNumber: "DHAKA-VAN-01" },
  update: { isActive: true },
  create: { type: "VAN", plateNumber: "DHAKA-VAN-01", capacityKg: 500 },
});
const hubManagerUser = await prisma.user.upsert({
  where: { email: "hubmanager@example.com" },
  update: { role: "HUB_MANAGER", emailVerifiedAt: new Date() },
  create: {
    email: "hubmanager@example.com",
    name: "Dhaka Hub Manager",
    role: "HUB_MANAGER",
    passwordHash,
    emailVerifiedAt: new Date(),
  },
});
await prisma.userBranch.upsert({
  where: { userId_branchId: { userId: hubManagerUser.id, branchId: branch.id } },
  update: {},
  create: { userId: hubManagerUser.id, branchId: branch.id },
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
  update: { hubId: destinationHub.id, isAvailable: true },
  create: { userId: riderUser.id, hubId: destinationHub.id, vehicleType: "Motorbike" },
});
const customer = await prisma.customer.upsert({
  where: { merchantId_phone: { merchantId: merchant.id, phone: "01800000000" } },
  update: { name: "Demo Customer", email: "customer@example.com" },
  create: {
    merchantId: merchant.id,
    name: "Demo Customer",
    phone: "01800000000",
    email: "customer@example.com",
  },
});
console.log({
  demoPassword: "Password123!",
  merchant: { email: "merchant@example.com", id: merchant.id },
  customer: { id: customer.id },
  originHub: { id: hub.id, code: hub.code },
  destinationHub: { id: destinationHub.id, code: destinationHub.code },
  hubManager: { email: "hubmanager@example.com" },
  rider: { email: "rider@example.com" },
  vehicle: { id: vehicle.id, plateNumber: vehicle.plateNumber },
});
await prisma.$disconnect();
