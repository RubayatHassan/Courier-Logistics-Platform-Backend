import { Router } from "express";
import { authenticate, authorize } from "../../middleware/auth.js";
import { asyncHandler } from "../../utils/http.js";
import { getHubs, getVehicles, postBranch, postHub, postHubManager, postRider, postVehicle } from "./controller.js";

export const operationsRouter = Router();
operationsRouter.use(authenticate, authorize("ADMIN"));
operationsRouter.post("/branches", asyncHandler(postBranch));
operationsRouter.post("/hubs", asyncHandler(postHub));
operationsRouter.post("/vehicles", asyncHandler(postVehicle));
operationsRouter.post("/hub-managers", asyncHandler(postHubManager));
operationsRouter.post("/riders", asyncHandler(postRider));
operationsRouter.get("/hubs", asyncHandler(getHubs));
operationsRouter.get("/vehicles", asyncHandler(getVehicles));
