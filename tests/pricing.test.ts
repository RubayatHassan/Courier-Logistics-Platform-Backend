import { describe, expect, it } from "vitest";
import { calculateDeliveryCharge } from "../src/app/module/parcels/workflow.js";

describe("pricing rules", () => {
  it("keeps the minimum delivery charge", () => {
    const charge = calculateDeliveryCharge(500);
    expect(charge).toBe(60);
  });
  it("adds a surcharge for each additional kilogram", () => {
    const charge = calculateDeliveryCharge(2500);
    expect(charge).toBe(100);
  });
});
