export const openApiDocument = {
  openapi: "3.0.3",
  info: { title: "Courier & Logistics Platform API", version: "1.0.0" },
  servers: [{ url: "/api/v1" }],
  tags: [{ name: "Auth" }, { name: "Parcels" }, { name: "Payments" }],
  components: {
    securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } },
    schemas: {
      Success: { type: "object", required: ["success", "message", "data"], properties: { success: { type: "boolean", example: true }, message: { type: "string", example: "Operation successful" }, data: { type: "object" } } },
      Error: { type: "object", required: ["success", "message", "errors"], properties: { success: { type: "boolean", example: false }, message: { type: "string" }, errors: { type: "array", items: {} } } },
      Credentials: { type: "object", required: ["email", "password"], properties: { email: { type: "string", format: "email" }, password: { type: "string", minLength: 8 } } },
      Parcel: { type: "object", properties: { id: { type: "string", format: "uuid" }, trackingNumber: { type: "string" }, status: { type: "string" }, weightGrams: { type: "integer" }, deliveryCharge: { type: "number" }, codAmount: { type: "number" } } },
    },
  },
  paths: {
    "/auth/register": { post: { tags: ["Auth"], summary: "Start email registration", requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/Credentials" } } } }, responses: { "201": { description: "Verification email sent" }, "400": { description: "Validation error" } } } },
    "/auth/verify-email": { post: { tags: ["Auth"], summary: "Verify email code or token", responses: { "200": { description: "Verified" } } } },
    "/auth/login": { post: { tags: ["Auth"], summary: "Email/password login", responses: { "200": { description: "JWT credentials" } } } },
    "/auth/google": { post: { tags: ["Auth"], summary: "Google Cloud OAuth login", responses: { "200": { description: "JWT credentials" } } } },
    "/auth/refresh": { post: { tags: ["Auth"], summary: "Refresh access token", responses: { "200": { description: "JWT credentials" } } } },
    "/auth/logout": { post: { tags: ["Auth"], summary: "Revoke refresh tokens", security: [{ bearerAuth: [] }], responses: { "200": { description: "Logged out" } } } },
    "/parcels": { get: { tags: ["Parcels"], summary: "List parcels", security: [{ bearerAuth: [] }], responses: { "200": { description: "Paginated parcels" } } }, post: { tags: ["Parcels"], summary: "Create parcel", security: [{ bearerAuth: [] }], responses: { "201": { description: "Parcel created" } } } },
    "/parcels/track/{trackingNumber}": { get: { tags: ["Parcels"], summary: "Public parcel tracking", parameters: [{ name: "trackingNumber", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "Tracking timeline" } } } },
    "/parcels/{id}/status": { patch: { tags: ["Parcels"], summary: "Transition parcel status", security: [{ bearerAuth: [] }], responses: { "200": { description: "Updated parcel" } } } },
    "/payments/stripe/checkout": { post: { tags: ["Payments"], summary: "Create a real Stripe Checkout session", security: [{ bearerAuth: [] }], responses: { "201": { description: "Checkout URL" } } } },
    "/payments/stripe/webhook": { post: { tags: ["Payments"], summary: "Stripe signed webhook", responses: { "200": { description: "Webhook accepted" } } } },
  },
};
