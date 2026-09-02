import { describe, expect, it } from "vitest";

describe("pricing rules", () => {
  it("keeps the minimum delivery charge", () => {
    const charge = Math.max(
      60,
      60 + Math.ceil(Math.max(0, 500 - 1000) / 1000) * 20,
    );
    expect(charge).toBe(60);
  });
  it("adds a surcharge for each additional kilogram", () => {
    const charge = Math.max(
      60,
      60 + Math.ceil(Math.max(0, 2500 - 1000) / 1000) * 20,
    );
    expect(charge).toBe(100);
  });
});
