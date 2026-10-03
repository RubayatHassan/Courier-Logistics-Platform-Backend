import { type Request, Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { authenticate, authorize } from "../../middleware/auth.js";
import { AppError, asyncHandler, ok } from "../../utils/http.js";
import type { AuthenticatedRequest } from "../../utils/types.js";
import { getCustomers, postCustomer } from "./controller.js";
import { cancelOwnParcel, listOwnParcels } from "./service.js";

export const customerRouter = Router();
customerRouter.use(authenticate);

async function verifiedCustomer(req: Request) {
  const actor = (req as AuthenticatedRequest).user;
  if (actor?.role !== "CUSTOMER")
    throw new AppError(403, "Customer account required");
  const user = await prisma.user.findUnique({
    where: { id: actor.id },
    select: { email: true, emailVerifiedAt: true },
  });
  if (!user?.emailVerifiedAt)
    throw new AppError(
      403,
      "Verify your email before using the customer portal",
    );
  return { actor, email: user.email };
}

customerRouter.get(
  "/me/parcels",
  authorize("CUSTOMER"),
  asyncHandler(async (req, res) => {
    const { email } = await verifiedCustomer(req);
    const query = z
      .object({
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(50).default(20),
      })
      .parse(req.query);
    return ok(res, await listOwnParcels(email, query.page, query.limit));
  }),
);

customerRouter.post(
  "/me/parcels/:id/cancel",
  authorize("CUSTOMER"),
  asyncHandler(async (req, res) => {
    const { actor, email } = await verifiedCustomer(req);
    const id = z.uuid().parse(req.params.id);
    const { reason } = z
      .object({ reason: z.string().trim().min(3).max(300) })
      .parse(req.body);
    return ok(
      res,
      await cancelOwnParcel(email, actor.id, id, reason),
      200,
      "Parcel cancelled successfully",
    );
  }),
);

customerRouter.get(
  "/",
  authorize("MERCHANT", "ADMIN"),
  asyncHandler(getCustomers),
);

customerRouter.post(
  "/",
  authorize("MERCHANT", "ADMIN"),
  asyncHandler(postCustomer),
);
