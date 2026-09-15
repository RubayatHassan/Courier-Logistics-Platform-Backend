import type { Request, Response } from "express";
import { z } from "zod";
import { AppError, ok } from "../../utils/http.js";
import type { AuthenticatedRequest } from "../../utils/types.js";
import { parseInput } from "../../utils/validation.js";
import { createCustomer, listCustomers } from "./service.js";

const createCustomerSchema = z.object({
  merchantId: z.uuid().optional(),
  name: z.string().min(2),
  phone: z.string().min(7).max(20),
  email: z.email().optional(),
});

function getActor(req: Request) {
  const actor = (req as AuthenticatedRequest).user;
  if (!actor) throw new AppError(401, "Authentication required");
  return actor;
}

export async function getCustomers(req: Request, res: Response) {
  const actor = getActor(req);
  const merchantId =
    typeof req.query.merchantId === "string" ? req.query.merchantId : undefined;
  return ok(res, await listCustomers(actor, merchantId));
}

export async function postCustomer(req: Request, res: Response) {
  const actor = getActor(req);
  const input = parseInput(createCustomerSchema, req.body);
  return ok(
    res,
    await createCustomer(actor, input),
    201,
    "Customer created successfully",
  );
}
