# Courier & Logistics Platform API

Modular monolith for merchant parcel booking, hub operations, rider delivery, tracking and COD collection. Settlement, refunds and the Order/Shipment layer currently have database models but no operational API workflows.

See [API workflow audit](docs/api-workflow-audit.md) for the API-to-API dependency map, fixes, test coverage, remaining production gaps and rollout requirements.

The Prisma schema also contains the full relational ERD layer: users/roles/sessions, orders/shipments/items, addresses and master data, assignments/riders/vehicles/locations, payment methods/invoices, notifications/templates/logs, returns/refunds/claims, audit/system settings, and the requested many-to-many junction tables.

## Run locally

1. Copy `.env.example` to `.env`.
2. Start a local PostgreSQL and Redis instance separately.
3. Install dependencies: `npm install`.
4. Generate Prisma client: `npm run db:generate`.
5. Apply schema: `npx prisma migrate dev --name init`.
6. Seed demo users: `npm run db:seed`.
7. Start API: `npm run dev`.

The API is available at `http://localhost:4000`. An importable Postman collection is available at `docs/postman_collection.json`.

Set `superAdminPassword` in your private Postman environment before using the super administrator login request. Keep real credentials out of the exported collection.

## Deploy to Vercel

This project exposes the Express app through `api/index.ts` for Vercel. Import the repository into Vercel, keep the default build settings, and add the environment variables from `.env.example` in the Vercel project settings. Set `NODE_ENV=production`, set `APP_URL` to the deployed URL, and set `CLIENT_ORIGIN` to the frontend origin. Use the hosted PostgreSQL and Redis URLs in `DATABASE_URL` and `REDIS_URL`; do not upload `.env`.

Before the first production request, apply the SQL in `prisma/manual-migrations/20260908000000_add_hub_transfer_vehicle_id.sql` to the production database and redeploy. The production API base URL will be `https://<your-project>.vercel.app/api/v1`.

## Email authentication

Registration does not log the user in immediately. The account remains unverified until the emailed six-digit code or verification link is submitted to `/api/v1/auth/verify-email`. Login is blocked for unverified users.

SMTP is optional for local development. Without SMTP, verification and reset messages are printed as `[dev-mail]` previews in the backend console; Redis still expires verification data after 15 minutes. `MAIL_FROM` is used in the preview and by SMTP when configured.

If real email delivery is needed, configure an SMTP provider in `.env`:

```env
APP_URL=http://localhost:4000
SMTP_HOST=smtp.your-provider.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-smtp-user
SMTP_PASS=your-smtp-password
MAIL_FROM="Courier Platform <no-reply@your-domain.com>"
```

Authentication endpoints:

- `POST /api/v1/auth/register` — stores a pending registration in Redis and sends verification email; no database user is created yet
- `POST /api/v1/auth/verify-email` — accepts `{ "email": "...", "code": "123456" }` or `{ "token": "..." }`
- `POST /api/v1/auth/resend-verification` — sends a new verification email
- `POST /api/v1/auth/forgot-password` — sends a one-time reset code/link to a verified email
- `POST /api/v1/auth/reset-password` — accepts `{ "password": "...", "code": "123456", "email": "..." }` or a reset `{ "token": "..." }`

Pending registrations expire from Redis after 15 minutes. Only a successful verification transaction creates the database user and optional merchant record.

After changing `prisma/schema.prisma`, run `npx prisma migrate dev --name <change-name>` to create and apply a migration against your local PostgreSQL instance.

For an existing deployment, apply pending migrations with `npx prisma migrate deploy` before restarting the API. The current deployed database also needs the one-time SQL in `prisma/manual-migrations/20260908000000_add_hub_transfer_vehicle_id.sql`; this is separate because the repository does not yet contain a baseline Prisma migration history.

Demo password: `Password123!` for the seeded accounts. Never use it outside local development.

Demo administrator: `admin@example.com` / `Password123!`. The seed also creates `merchant@example.com` and `rider@example.com` with the same local-only password.

The environment-configured super administrator is bootstrapped on server startup from `SUPER_ADMIN_EMAIL` and `SUPER_ADMIN_PASSWORD`. Only this role can create additional administrators with `POST /api/v1/auth/admins`; all protected endpoints also accept the super administrator role.

Google Cloud login requires a Google OAuth web client ID in `GOOGLE_CLIENT_ID`. The API verifies the Google ID token against Google's tokeninfo endpoint before creating or signing in the customer.

Stripe checkout requires `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`. Checkout sessions use a durable payment ID as the provider idempotency key. Signed completed/async-success webhooks or an authenticated provider session lookup confirm payment after amount/currency validation. When a paid online checkout is confirmed while its parcel is `OUT_FOR_DELIVERY`, the webhook atomically marks the parcel `DELIVERED`, completes the active delivery assignment and records a tracking event; a retry after the status update only clears the short-lived tracking cache. COD parcels continue to be marked delivered by the rider, which records COD collection. Expired/async-failed sessions release the pending payment for retry. The success landing page only reads local payment status. There are no simulated payment success paths.

Redis is required for authentication rate limits; protected authentication actions return 503 if Redis is unavailable. Production email requires SMTP and never prints verification/reset secrets as development previews. Configure trusted proxy handling for the actual deployment before relying on per-client IP limits; forwarded headers are not blindly trusted.

After the refresh-token security update, existing sessions using the old bcrypt token hash must log in again. New refresh tokens use SHA-256 fingerprints, random token IDs, atomic single-use rotation and cookie/database expiry derived from the configured token TTL.

Hub managers are now assigned to one explicit hub through `User.managedHubId`. Branch membership does not grant parcel or rider access. Before deploying this update, apply `prisma/manual-migrations/20261003000000_scope_managers_to_hubs.sql`, then explicitly assign existing managers using admin `PATCH /api/v1/operations/hub-managers/:id/hub` with `{ "hubId": "..." }`. Managers without a hub see no parcels/riders and cannot perform hub operations. New manager creation requires `hubId`; optional `branchId` must match that hub. Local riders must belong to the parcel's current hub and be active/available. Geographic zones are not modeled separately.

Managers use `GET /operations/hubs` for their own hub, and `GET /operations/transfer-destinations` for the limited destination directory (id/name/code/city only). The latter grants no access to destination parcels or riders. Demo seed creates `hubmanager@example.com` for the origin hub and `destinationmanager@example.com` for the destination hub; switch logins before receiving the transfer.

## API conventions

Use `Authorization: Bearer <accessToken>` for authenticated endpoints. Every response uses `{ success, message, data }` on success and `{ success, message, errors }` on errors. Merchant parcel creation accepts an `Idempotency-Key` header. Public tracking is available at `/api/v1/parcels/track/:trackingNumber`.

Example error response:

```json
{
  "success": false,
  "message": "Validation failed",
  "errors": [{ "path": ["weightGrams"], "message": "Too small: expected number to be >0" }]
}
```

## Customer self-service

Customers can register through `/auth/register` without `merchantName`, verify their email and log in. Merchants add that same email to the recipient record when creating a customer. The customer then uses `GET /api/v1/customers/me/parcels` to see only parcels addressed to their verified account email. `POST /api/v1/customers/me/parcels/:id/cancel` accepts a short reason and cancels only that customer's parcel while its status is `CREATED` or `PICKUP_ASSIGNED`. After pickup, use public tracking or the existing recipient Stripe checkout flow; cancellation is not available. The seed account is `customer@example.com` with the local demo password `Password123!`.
