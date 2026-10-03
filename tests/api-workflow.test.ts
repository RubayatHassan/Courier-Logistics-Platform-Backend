import crypto from "node:crypto";
import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const model = () => ({
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    createMany: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    count: vi.fn(),
  });
  return {
    db: {
      parcel: model(),
      payment: model(),
      codLedger: model(),
      user: model(),
      customer: model(),
      merchant: model(),
      hub: model(),
      hubTransfer: model(),
      vehicle: model(),
      rider: model(),
      warehouseBranch: model(),
      userBranch: model(),
      deliveryAssignment: model(),
      trackingEvent: model(),
      notification: model(),
      auditLog: model(),
      refreshToken: model(),
      $transaction: vi.fn(),
      $queryRaw: vi.fn(),
    },
    redis: { eval: vi.fn(), del: vi.fn() },
  };
});
vi.mock("../src/app/lib/prisma.js", () => ({ prisma: mocks.db }));
vi.mock("../src/app/lib/redis.js", () => ({
  redis: mocks.redis,
  connectRedis: vi.fn(),
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn(),
}));
vi.mock("../src/app/lib/mail.js", () => ({
  sendEmail: vi.fn(),
  verificationEmail: vi.fn(),
  passwordResetEmail: vi.fn(),
}));

import {
  refreshTokenExpiry,
  refreshTokenHash,
  signAccessToken,
  signRefreshToken,
} from "../src/app/middleware/auth.js";
import {
  createParcel,
  transitionParcel,
} from "../src/app/module/parcels/service.js";
import { createStripeCheckout } from "../src/app/module/payments/service.js";
import { app } from "../src/app.js";

const request = createRequire(import.meta.url)("supertest");
const db = mocks.db;
const ids = {
  parcel: "11111111-1111-4111-8111-111111111111",
  merchant: "22222222-2222-4222-8222-222222222222",
  customer: "33333333-3333-4333-8333-333333333333",
  origin: "44444444-4444-4444-8444-444444444444",
  destination: "55555555-5555-4555-8555-555555555555",
  rider: "66666666-6666-4666-8666-666666666666",
};
const actors = {
  merchant: {
    id: "merchant-user",
    email: "merchant@test.com",
    role: "MERCHANT" as const,
    merchantId: ids.merchant,
  },
  manager: {
    id: "manager-user",
    email: "manager@test.com",
    role: "HUB_MANAGER" as const,
    merchantId: null,
  },
  destinationManager: {
    id: "destination-manager",
    email: "destination@test.com",
    role: "HUB_MANAGER" as const,
    merchantId: null,
  },
  unassignedManager: {
    id: "unassigned-manager",
    email: "unassigned@test.com",
    role: "HUB_MANAGER" as const,
    merchantId: null,
  },
  rider: {
    id: "rider-user",
    email: "rider@test.com",
    role: "RIDER" as const,
    merchantId: null,
  },
  admin: {
    id: "admin-user",
    email: "admin@test.com",
    role: "ADMIN" as const,
    merchantId: null,
  },
};
const auth = (actor: keyof typeof actors) =>
  `Bearer ${signAccessToken(actors[actor])}`;
const newParcel = () => ({
  id: ids.parcel,
  trackingNumber: "CLPTEST",
  merchantId: ids.merchant,
  customerId: ids.customer,
  status: "CREATED",
  currentHubId: null as string | null,
  codAmount: 500,
  deliveryCharge: 60,
  weightGrams: 1000,
  pickupAddress: "Origin address",
  deliveryAddress: "Destination address",
  updatedAt: new Date(0),
  createdAt: new Date(0),
});
let parcel = newParcel();
let transfers: { toHubId: string; toHub: { name: string } }[] = [];
let activeAssignment = false;
let managerHubs: Record<string, string | null>;
let localRiderAvailable = true;
let localRiderStatus = "ACTIVE";

beforeEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  parcel = newParcel();
  transfers = [];
  activeAssignment = false;
  managerHubs = {
    [actors.manager.id]: ids.origin,
    [actors.destinationManager.id]: ids.destination,
    [actors.unassignedManager.id]: null,
  };
  localRiderAvailable = true;
  localRiderStatus = "ACTIVE";
  mocks.redis.eval.mockResolvedValue(1);
  db.$transaction.mockImplementation(async (fn) =>
    typeof fn === "function" ? fn(db) : Promise.all(fn),
  );
  db.user.findUnique.mockImplementation(async ({ where }) =>
    Object.values(actors).find((actor) => actor.id === where.id),
  );
  db.parcel.findFirst.mockImplementation(async ({ where }) => {
    if (where.merchantId && where.merchantId !== parcel.merchantId) return null;
    if (where.assignments && !activeAssignment) return null;
    if (
      where.currentHub?.managers &&
      managerHubs[where.currentHub.managers.some.id] !== parcel.currentHubId
    )
      return null;
    return parcel;
  });
  db.parcel.findUnique.mockImplementation(async () => ({
    ...parcel,
    currentHub: parcel.currentHubId
      ? {
          id: parcel.currentHubId,
          branch: { userBranches: [{ userId: actors.manager.id }] },
        }
      : null,
    transfers,
  }));
  db.parcel.findUniqueOrThrow.mockImplementation(async () => parcel);
  db.parcel.updateMany.mockImplementation(async ({ where, data }) => {
    if (where.status && where.status !== parcel.status) return { count: 0 };
    parcel = { ...parcel, ...data, updatedAt: new Date() };
    return { count: 1 };
  });
  db.hub.findFirst.mockImplementation(async ({ where }) => {
    if (where.managers && managerHubs[where.managers.some.id] !== where.id)
      return null;
    return { id: where.id, name: "Test Hub", branchId: "shared-branch" };
  });
  db.user.findMany.mockResolvedValue([]);
  db.hubTransfer.create.mockImplementation(async ({ data }) => {
    transfers = [{ toHubId: data.toHubId, toHub: { name: "Destination" } }];
    return data;
  });
  db.rider.findFirst.mockImplementation(async ({ where }) =>
    where.id === ids.rider &&
    where.hubId === ids.destination &&
    localRiderAvailable &&
    localRiderStatus === "ACTIVE"
      ? { id: ids.rider, hubId: ids.destination }
      : null,
  );
  db.userBranch.findFirst.mockResolvedValue({ userId: actors.manager.id });
  db.deliveryAssignment.create.mockImplementation(async ({ data }) => {
    activeAssignment = true;
    return { id: "assignment", ...data };
  });
  db.deliveryAssignment.updateMany.mockImplementation(async () => {
    activeAssignment = false;
    return { count: 1 };
  });
  db.payment.findFirst.mockResolvedValue(null);
  db.payment.updateMany.mockResolvedValue({ count: 1 });
  db.refreshToken.updateMany.mockResolvedValue({ count: 1 });
});

describe("HTTP parcel workflow", () => {
  it("connects origin → dispatch → arrival → rider → delivery, collecting COD once", async () => {
    const base = `/api/v1/parcels/${ids.parcel}`;
    expect(
      (
        await request(app)
          .post(`${base}/assign-origin-hub`)
          .set("Authorization", auth("merchant"))
          .send({ hubId: ids.origin })
      ).status,
    ).toBe(200);
    expect(parcel.status).toBe("AT_HUB");
    expect(
      (
        await request(app)
          .post(`${base}/dispatch`)
          .set("Authorization", auth("manager"))
          .send({ destinationHubId: ids.destination })
      ).status,
    ).toBe(200);
    expect(parcel.status).toBe("IN_TRANSIT");
    expect(parcel.currentHubId).toBe(ids.origin);
    expect(
      (
        await request(app)
          .post(`${base}/mark-arrived`)
          .set("Authorization", auth("destinationManager"))
          .send({})
      ).status,
    ).toBe(200);
    expect(parcel.currentHubId).toBe(ids.destination);
    expect(
      (
        await request(app)
          .post(`${base}/assign-rider`)
          .set("Authorization", auth("destinationManager"))
          .send({ riderId: ids.rider })
      ).status,
    ).toBe(201);
    expect(parcel.status).toBe("OUT_FOR_DELIVERY");
    const delivered = await request(app)
      .patch(`${base}/status`)
      .set("Authorization", auth("rider"))
      .send({ status: "DELIVERED" });
    expect(delivered.status).toBe(200);
    expect(db.payment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "PAID" } }),
    );
    expect(activeAssignment).toBe(false);
    expect(db.codLedger.create).toHaveBeenCalledTimes(1);
    expect(
      (
        await request(app)
          .patch(`${base}/status`)
          .set("Authorization", auth("admin"))
          .send({ status: "DELIVERED" })
      ).status,
    ).toBe(409);
  });

  it.each(["DELIVERED", "CANCELLED", "RETURNED", "OUT_FOR_DELIVERY"])(
    "does not reset %s to origin hub",
    async (status) => {
      parcel.status = status;
      const result = await request(app)
        .post(`/api/v1/parcels/${ids.parcel}/assign-origin-hub`)
        .set("Authorization", auth("merchant"))
        .send({ hubId: ids.origin });
      expect(result.status).toBe(409);
      expect(db.parcel.updateMany).not.toHaveBeenCalled();
    },
  );

  it("rejects duplicate dispatch before creating a transfer", async () => {
    parcel.status = "AT_HUB";
    parcel.currentHubId = ids.origin;
    db.parcel.updateMany.mockResolvedValueOnce({ count: 0 });
    const result = await request(app)
      .post(`/api/v1/parcels/${ids.parcel}/dispatch`)
      .set("Authorization", auth("manager"))
      .send({ destinationHubId: ids.destination });
    expect(result.status).toBe(409);
    expect(db.hubTransfer.create).not.toHaveBeenCalled();
  });

  it("rejects dispatch to the same hub", async () => {
    parcel.status = "AT_HUB";
    parcel.currentHubId = ids.origin;
    expect(
      (
        await request(app)
          .post(`/api/v1/parcels/${ids.parcel}/dispatch`)
          .set("Authorization", auth("manager"))
          .send({ destinationHubId: ids.origin })
      ).status,
    ).toBe(409);
  });

  it("dispatches a sorted parcel without resetting its status manually", async () => {
    parcel.status = "SORTING";
    parcel.currentHubId = ids.origin;
    const result = await request(app)
      .post(`/api/v1/parcels/${ids.parcel}/dispatch`)
      .set("Authorization", auth("manager"))
      .send({ destinationHubId: ids.destination });
    expect(result.status).toBe(200);
    expect(parcel.status).toBe("IN_TRANSIT");
  });

  it.each(["PICKUP_ASSIGNED", "AT_HUB", "OUT_FOR_DELIVERY"])(
    "prevents the generic status endpoint bypassing the %s workflow",
    async (status) => {
      expect(
        (
          await request(app)
            .patch(`/api/v1/parcels/${ids.parcel}/status`)
            .set("Authorization", auth("admin"))
            .send({ status })
        ).status,
      ).toBe(409);
    },
  );

  it("rejects a rider with only a completed assignment", async () => {
    parcel.status = "OUT_FOR_DELIVERY";
    expect(
      (
        await request(app)
          .patch(`/api/v1/parcels/${ids.parcel}/status`)
          .set("Authorization", auth("rider"))
          .send({ status: "DELIVERED" })
      ).status,
    ).toBe(404);
  });

  it("allows a failed delivery to receive a new rider assignment", async () => {
    parcel.status = "DELIVERY_FAILED";
    parcel.currentHubId = ids.destination;
    expect(
      (
        await request(app)
          .post(`/api/v1/parcels/${ids.parcel}/assign-rider`)
          .set("Authorization", auth("destinationManager"))
          .send({ riderId: ids.rider })
      ).status,
    ).toBe(201);
  });

  it("does not let an origin manager receive another hub's transfer in the same branch", async () => {
    parcel.status = "IN_TRANSIT";
    transfers = [{ toHubId: ids.destination, toHub: { name: "Destination" } }];
    expect(
      (
        await request(app)
          .post(`/api/v1/parcels/${ids.parcel}/mark-arrived`)
          .set("Authorization", auth("manager"))
          .send({})
      ).status,
    ).toBe(403);
  });
});

describe("exact hub manager authorization", () => {
  it.each(["manager", "destinationManager", "unassignedManager"] as const)(
    "lists only %s's hub parcels and scoped totals",
    async (actor) => {
      const rows = [
        { ...parcel, currentHubId: ids.origin },
        { ...parcel, id: "other-parcel", currentHubId: ids.destination },
      ];
      const scoped = (where: {
        currentHub?: { managers?: { some: { id: string } } };
      }) =>
        rows.filter(
          (row) =>
            row.currentHubId ===
            managerHubs[where.currentHub?.managers?.some.id ?? ""],
        );
      db.parcel.findMany.mockImplementation(async ({ where }) => scoped(where));
      db.parcel.count.mockImplementation(
        async ({ where }) => scoped(where).length,
      );
      const response = await request(app)
        .get("/api/v1/parcels")
        .set("Authorization", auth(actor));
      expect(response.status).toBe(200);
      expect(
        response.body.data.items.map(
          (row: { currentHubId: string }) => row.currentHubId,
        ),
      ).toEqual(
        actor === "unassignedManager" ? [] : [managerHubs[actors[actor].id]],
      );
      expect(response.body.data.meta.total).toBe(
        actor === "unassignedManager" ? 0 : 1,
      );
      expect(db.parcel.findMany.mock.calls[0]?.[0].where).toMatchObject({
        currentHub: {
          isActive: true,
          managers: { some: { id: actors[actor].id, role: "HUB_MANAGER" } },
        },
      });
    },
  );

  it("cannot assign a local rider to another hub's parcel even in the same branch", async () => {
    parcel.status = "AT_HUB";
    parcel.currentHubId = ids.destination;
    const response = await request(app)
      .post(`/api/v1/parcels/${parcel.id}/assign-rider`)
      .set("Authorization", auth("manager"))
      .send({ riderId: ids.rider });
    expect(response.status).toBe(403);
    expect(db.deliveryAssignment.create).not.toHaveBeenCalled();
  });

  it("cannot assign another hub's rider to its own parcel", async () => {
    parcel.status = "AT_HUB";
    parcel.currentHubId = ids.origin;
    const response = await request(app)
      .post(`/api/v1/parcels/${parcel.id}/assign-rider`)
      .set("Authorization", auth("manager"))
      .send({ riderId: ids.rider });
    expect(response.status).toBe(404);
    expect(db.rider.findFirst).toHaveBeenCalledWith({
      where: {
        id: ids.rider,
        hubId: ids.origin,
        isAvailable: true,
        status: "ACTIVE",
      },
    });
    expect(db.deliveryAssignment.create).not.toHaveBeenCalled();
  });

  it.each(["unavailable", "inactive"])(
    "cannot assign an %s local rider",
    async (condition) => {
      parcel.status = "AT_HUB";
      parcel.currentHubId = ids.destination;
      if (condition === "unavailable") localRiderAvailable = false;
      else localRiderStatus = "INACTIVE";
      expect(
        (
          await request(app)
            .post(`/api/v1/parcels/${parcel.id}/assign-rider`)
            .set("Authorization", auth("destinationManager"))
            .send({ riderId: ids.rider })
        ).status,
      ).toBe(404);
      expect(db.deliveryAssignment.create).not.toHaveBeenCalled();
    },
  );

  it("cannot dispatch another hub's parcel", async () => {
    parcel.status = "AT_HUB";
    parcel.currentHubId = ids.destination;
    expect(
      (
        await request(app)
          .post(`/api/v1/parcels/${parcel.id}/dispatch`)
          .set("Authorization", auth("manager"))
          .send({ destinationHubId: ids.origin })
      ).status,
    ).toBe(403);
    expect(db.hubTransfer.create).not.toHaveBeenCalled();
  });

  it("cannot change another hub's parcel status", async () => {
    parcel.status = "AT_HUB";
    parcel.currentHubId = ids.destination;
    expect(
      (
        await request(app)
          .patch(`/api/v1/parcels/${parcel.id}/status`)
          .set("Authorization", auth("manager"))
          .send({ status: "SORTING" })
      ).status,
    ).toBe(404);
    expect(db.parcel.updateMany).not.toHaveBeenCalled();
  });

  it("scopes rider lookup even when a different hubId is supplied", async () => {
    db.rider.findMany.mockImplementation(async ({ where }) =>
      managerHubs[where.hub.managers.some.id] === where.hubId
        ? [{ id: ids.rider }]
        : [],
    );
    const response = await request(app)
      .get(`/api/v1/operations/riders?hubId=${ids.destination}`)
      .set("Authorization", auth("manager"));
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([]);
    expect(db.rider.findMany.mock.calls[0]?.[0].where).toMatchObject({
      hubId: ids.destination,
      hub: { managers: { some: { id: actors.manager.id } } },
    });
  });

  it("does not notify other managers in the same branch", async () => {
    db.user.findMany.mockResolvedValue([{ id: actors.manager.id }]);
    expect(
      (
        await request(app)
          .post(`/api/v1/parcels/${parcel.id}/assign-origin-hub`)
          .set("Authorization", auth("merchant"))
          .send({ hubId: ids.origin })
      ).status,
    ).toBe(200);
    expect(db.user.findMany).toHaveBeenCalledWith({
      where: { role: "HUB_MANAGER", managedHubId: ids.origin },
      select: { id: true },
    });
  });

  it("requires a concrete hub when creating a manager", async () => {
    const response = await request(app)
      .post("/api/v1/operations/hub-managers")
      .set("Authorization", auth("admin"))
      .send({
        email: "new@test.com",
        name: "Manager",
        password: "Password123!",
        branchId: ids.origin,
      });
    expect(response.status).toBe(400);
    expect(db.user.create).not.toHaveBeenCalled();
  });

  it("creates a manager assigned to one hub", async () => {
    db.user.create.mockImplementation(async ({ data }) => ({
      id: "new-manager",
      ...data,
    }));
    const response = await request(app)
      .post("/api/v1/operations/hub-managers")
      .set("Authorization", auth("admin"))
      .send({
        email: "new@test.com",
        name: "Manager",
        password: "Password123!",
        hubId: ids.origin,
      });
    expect(response.status).toBe(201);
    expect(db.user.create.mock.calls[0]?.[0].data).toMatchObject({
      role: "HUB_MANAGER",
      managedHubId: ids.origin,
    });
    expect(response.body.data.hubId).toBe(ids.origin);
    expect(response.body.data.passwordHash).toBeUndefined();
  });

  it("returns only its own hub from the manager hub lookup", async () => {
    db.hub.findMany.mockImplementation(async ({ where }) => [
      { id: managerHubs[where.managers.some.id] },
    ]);
    const response = await request(app)
      .get("/api/v1/operations/hubs")
      .set("Authorization", auth("manager"));
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([{ id: ids.origin }]);
    expect(db.hub.findMany.mock.calls[0]?.[0].where).toMatchObject({
      isActive: true,
      managers: { some: { id: actors.manager.id } },
    });
  });

  it("allows only admin to change manager hub mapping", async () => {
    const path = `/api/v1/operations/hub-managers/${ids.customer}/hub`;
    expect(
      (
        await request(app)
          .patch(path)
          .set("Authorization", auth("manager"))
          .send({ hubId: ids.origin })
      ).status,
    ).toBe(403);
    db.user.updateMany.mockResolvedValue({ count: 1 });
    expect(
      (
        await request(app)
          .patch(path)
          .set("Authorization", auth("admin"))
          .send({ hubId: ids.origin })
      ).status,
    ).toBe(200);
    expect(db.user.updateMany).toHaveBeenCalledWith({
      where: { id: ids.customer, role: "HUB_MANAGER" },
      data: { managedHubId: ids.origin },
    });
  });
});

describe("booking and operation relations", () => {
  it("does not create a zero-value pending online payment", async () => {
    db.parcel.create.mockResolvedValue(parcel);
    await createParcel({ ...parcel, codAmount: 0 });
    expect(db.payment.create).not.toHaveBeenCalled();
  });
  it("returns the original parcel for the same idempotency key and rejects changed payload", async () => {
    expect(
      await createParcel({ ...parcel, idempotencyKey: "booking-1" }),
    ).toEqual(parcel);
    await expect(
      createParcel({
        ...parcel,
        idempotencyKey: "booking-1",
        weightGrams: 2000,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
  it("recovers the concurrent idempotent booking winner", async () => {
    db.parcel.findFirst.mockResolvedValueOnce(null).mockResolvedValue(parcel);
    db.parcel.create.mockRejectedValue({ code: "P2002" });
    expect(
      await createParcel({ ...parcel, idempotencyKey: "booking-1" }),
    ).toEqual(parcel);
  });
  it("rejects a customer outside the merchant before creating a parcel", async () => {
    db.customer.findFirst.mockResolvedValue(null);
    expect(
      (
        await request(app)
          .post("/api/v1/parcels")
          .set("Authorization", auth("merchant"))
          .send(parcel)
      ).status,
    ).toBe(404);
    expect(db.parcel.create).not.toHaveBeenCalled();
  });
  it("creates a hub without leaking Branch-only fields to Prisma", async () => {
    db.hub.findUnique.mockResolvedValue(null);
    db.hub.create.mockResolvedValue({ id: ids.origin });
    const result = await request(app)
      .post("/api/v1/operations/hubs")
      .set("Authorization", auth("admin"))
      .send({
        name: "Dhaka",
        code: "DHK",
        address: "Dhaka address",
        city: "Dhaka",
        type: "HUB",
        email: "ignored@test.com",
      });
    expect(result.status).toBe(201);
    expect(db.hub.create).toHaveBeenCalledWith({
      data: {
        name: "Dhaka",
        code: "DHK",
        address: "Dhaka address",
        city: "Dhaka",
      },
    });
  });
});

describe("payments", () => {
  const payment = () => ({
    id: "payment-1",
    parcelId: ids.parcel,
    amount: 500,
    createdAt: new Date(),
    providerReference: null,
  });
  const session = () => ({
    id: "cs_fixture",
    url: "https://checkout.stripe.com/test",
    currency: "bdt",
    amount_total: 50000,
    payment_status: "paid",
    metadata: { parcelId: ids.parcel, paymentId: "payment-1" },
  });
  async function webhook(type: string, object = session(), valid = true) {
    const raw = JSON.stringify({ type, data: { object } });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = crypto
      .createHmac("sha256", "whsec_fixture")
      .update(`${timestamp}.${raw}`)
      .digest("hex");
    return request(app)
      .post("/api/v1/payments/stripe/webhook")
      .set("Content-Type", "application/json")
      .set(
        "stripe-signature",
        `t=${timestamp},v1=${valid ? signature : "0".repeat(64)}`,
      )
      .send(raw);
  }
  it("reuses a durable payment and the same Stripe idempotency key on retry", async () => {
    db.payment.findFirst.mockImplementation(async ({ where }) =>
      where.method === "ONLINE" ? payment() : null,
    );
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ...session(), payment_status: "unpaid" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    await createStripeCheckout(ids.parcel);
    await createStripeCheckout(ids.parcel);
    expect(db.payment.create).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls[0]?.[1].headers["Idempotency-Key"]).toBe(
      "parcel-payment-payment-1",
    );
    expect(fetchMock.mock.calls[1]?.[1].headers["Idempotency-Key"]).toBe(
      "parcel-payment-payment-1",
    );
    expect(
      new URLSearchParams(fetchMock.mock.calls[0]?.[1].body as string).get(
        "success_url",
      ),
    ).toContain("session_id={CHECKOUT_SESSION_ID}");
  });
  it("reconciles a paid Stripe return when the webhook is delayed", async () => {
    parcel.status = "OUT_FOR_DELIVERY";
    const pendingPayment = {
      ...payment(),
      method: "ONLINE",
      status: "PENDING",
      providerReference: "cs_fixture",
    };
    const paidPayment = { ...pendingPayment, status: "PAID" };
    db.payment.findFirst
      .mockResolvedValueOnce(pendingPayment)
      .mockResolvedValueOnce(pendingPayment)
      .mockResolvedValueOnce({
        ...paidPayment,
        parcel: { trackingNumber: parcel.trackingNumber, status: "DELIVERED" },
      });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => session(),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await request(app).get(
      "/api/v1/payments/stripe/checkout/cs_fixture/status",
    );

    expect(result.status).toBe(200);
    expect(result.body.data).toEqual({
      paymentStatus: "PAID",
      parcelStatus: "DELIVERED",
      trackingNumber: parcel.trackingNumber,
    });
    expect(parcel.status).toBe("DELIVERED");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("blocks delivery while a positive online payment is pending", async () => {
    parcel.status = "OUT_FOR_DELIVERY";
    db.payment.findFirst.mockResolvedValue({ ...payment(), status: "PENDING" });
    await expect(
      transitionParcel(
        parcel.id,
        null,
        "DELIVERED",
        actors.admin.id,
        undefined,
        "ADMIN",
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(db.parcel.updateMany).not.toHaveBeenCalled();
  });
  it("rejects invalid webhook signatures before database access", async () => {
    expect(
      (await webhook("checkout.session.completed", session(), false)).status,
    ).toBe(400);
    expect(db.payment.findFirst).not.toHaveBeenCalled();
  });

  it("delivers an online-paid parcel without collecting COD", async () => {
    parcel.status = "OUT_FOR_DELIVERY";
    db.payment.findFirst.mockImplementation(async ({ where }) =>
      where.status === "PENDING" ? null : { ...payment(), status: "PAID" },
    );
    await transitionParcel(
      parcel.id,
      null,
      "DELIVERED",
      actors.admin.id,
      undefined,
      "ADMIN",
    );
    expect(parcel.status).toBe("DELIVERED");
    expect(db.codLedger.create).not.toHaveBeenCalled();
    expect(db.payment.updateMany).not.toHaveBeenCalled();
  });

  it("delivers a zero-COD parcel without requiring an online checkout", async () => {
    parcel.status = "OUT_FOR_DELIVERY";
    parcel.codAmount = 0;
    await transitionParcel(
      parcel.id,
      null,
      "DELIVERED",
      actors.admin.id,
      undefined,
      "ADMIN",
    );
    expect(parcel.status).toBe("DELIVERED");
    expect(db.codLedger.create).not.toHaveBeenCalled();
  });

  it("rejects inconsistent COD records instead of inventing a collection", async () => {
    parcel.status = "OUT_FOR_DELIVERY";
    db.payment.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      transitionParcel(
        parcel.id,
        null,
        "DELIVERED",
        actors.admin.id,
        undefined,
        "ADMIN",
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(db.codLedger.create).not.toHaveBeenCalled();
  });
  it.each([
    "checkout.session.completed",
    "checkout.session.async_payment_succeeded",
  ])("confirms %s and disables pending COD", async (eventType) => {
    db.payment.findFirst.mockResolvedValue(payment());
    expect((await webhook(eventType)).status).toBe(200);
    expect(db.payment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: "PAID", providerReference: "cs_fixture" },
      }),
    );
    expect(db.payment.updateMany).toHaveBeenCalledWith({
      where: { parcelId: ids.parcel, method: "COD", status: "PENDING" },
      data: { status: "FAILED" },
    });
  });
  it.each([
    "checkout.session.expired",
    "checkout.session.async_payment_failed",
  ])("releases an unsuccessful %s for retry", async (eventType) => {
    db.payment.findFirst.mockResolvedValue(payment());
    expect(
      (await webhook(eventType, { ...session(), payment_status: "unpaid" }))
        .status,
    ).toBe(200);
    expect(db.payment.updateMany).toHaveBeenCalledTimes(1);
    expect(db.payment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: "FAILED", providerReference: "cs_fixture" },
      }),
    );
  });
  it("does not repeat side effects for duplicate webhook delivery", async () => {
    db.payment.findFirst.mockResolvedValue(payment());
    db.payment.updateMany.mockResolvedValue({ count: 0 });
    expect((await webhook("checkout.session.completed")).status).toBe(200);
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });
  it("rejects a signed webhook with a mismatched amount", async () => {
    db.payment.findFirst.mockResolvedValue(payment());
    expect(
      (
        await webhook("checkout.session.completed", {
          ...session(),
          amount_total: 1,
        })
      ).status,
    ).toBe(400);
    expect(db.payment.updateMany).not.toHaveBeenCalled();
  });
  it.each(["DELIVERED", "RETURNED", "CANCELLED"])(
    "cannot create checkout for %s",
    async (status) => {
      parcel.status = status;
      await expect(createStripeCheckout(parcel.id)).rejects.toMatchObject({
        statusCode: 409,
      });
    },
  );
});

describe("authentication and HTTP safety", () => {
  it("generates distinct refresh tokens even within the same second", () => {
    const first = signRefreshToken(actors.admin.id);
    const second = signRefreshToken(actors.admin.id);
    expect(first).not.toBe(second);
    expect(refreshTokenHash(first)).not.toBe(refreshTokenHash(second));
    expect(refreshTokenExpiry(first).getTime() - Date.now()).toBeGreaterThan(
      3590000,
    );
  });
  it("rotates a refresh token by atomically consuming its exact hash", async () => {
    const token = signRefreshToken(actors.admin.id);
    const result = await request(app)
      .post("/api/v1/auth/refresh")
      .set("Cookie", `refreshToken=${token}`)
      .send({});
    expect(result.status).toBe(200);
    expect(db.refreshToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tokenHash: refreshTokenHash(token),
          revokedAt: null,
        }),
      }),
    );
    expect(result.headers["set-cookie"][0]).toMatch(/Max-Age=(359[0-9]|3600)/);
  });
  it("rejects a refresh token already consumed by a concurrent request", async () => {
    db.refreshToken.updateMany.mockResolvedValue({ count: 0 });
    const result = await request(app)
      .post("/api/v1/auth/refresh")
      .set("Cookie", `refreshToken=${signRefreshToken(actors.admin.id)}`)
      .send({});
    expect(result.status).toBe(401);
    expect(db.refreshToken.create).not.toHaveBeenCalled();
  });
  it("limits verification attempts", async () => {
    mocks.redis.eval.mockResolvedValue(61);
    expect(
      (
        await request(app)
          .post("/api/v1/auth/verify-email")
          .send({ email: "customer@test.com", code: "123456" })
      ).status,
    ).toBe(429);
  });
  it("returns 400 for malformed JSON", async () => {
    expect(
      (
        await request(app)
          .post("/api/v1/auth/login")
          .set("Content-Type", "application/json")
          .send("{broken")
      ).status,
    ).toBe(400);
  });
});
