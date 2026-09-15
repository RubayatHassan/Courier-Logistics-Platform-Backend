import { Router } from "express";
import { authenticate, authorize } from "../../middleware/auth.js";
import { asyncHandler } from "../../shared/http.js";
import { getCustomers, postCustomer } from "./controller.js";

export const customerRouter = Router();
customerRouter.use(authenticate);

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
