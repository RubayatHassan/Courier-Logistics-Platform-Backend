import type { Prisma } from "../../../generated/prisma/client.js";
import { prisma } from "../../lib/prisma.js";
import { AppError } from "../../utils/http.js";

export function managedHubScope(userId: string): Prisma.HubWhereInput {
  return {
    isActive: true,
    managers: { some: { id: userId, role: "HUB_MANAGER" } },
  };
}

export async function requireManagedHub(userId: string, hubId: string) {
  const hub = await prisma.hub.findFirst({
    where: { id: hubId, ...managedHubScope(userId) },
    select: { id: true },
  });
  if (!hub) throw new AppError(403, "Hub is outside your assigned hub scope");
}
