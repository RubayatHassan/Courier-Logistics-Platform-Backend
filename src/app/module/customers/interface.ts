import type { Role } from "../../../generated/prisma/client.js";

export type CustomerActor = {
  id: string;
  role: Role;
  merchantId: string | null;
};

export type CreateCustomerInput = {
  merchantId?: string;
  name: string;
  phone: string;
  email?: string;
};
