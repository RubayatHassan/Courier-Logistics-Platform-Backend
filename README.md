# Courier & Logistics Platform API

Industry-oriented modular monolith for merchant parcel booking, hub operations, rider delivery, tracking and COD settlement.

The Prisma schema also contains the full relational ERD layer: users/roles/sessions, orders/shipments/items, addresses and master data, assignments/riders/vehicles/locations, payment methods/invoices, notifications/templates/logs, returns/refunds/claims, audit/system settings, and the requested many-to-many junction tables.

## Run locally

1. Copy `.env.example` to `.env`.
2. Start a local PostgreSQL and Redis instance separately.
3. Install dependencies: `npm install`.
4. Generate Prisma client: `npm run db:generate`.
5. Apply schema: `npx prisma migrate dev --name init`.
6. Seed demo users: `npm run db:seed`.
7. Start API: `npm run dev`.

The API is available at `http://localhost:4000`. OpenAPI JSON is at `/api/v1/openapi.json`.

## Email authentication

Registration does not log the user in immediately. The account remains unverified until the emailed six-digit code or verification link is submitted to `/api/v1/auth/verify-email`. Login is blocked for unverified users.

Configure a real SMTP provider in `.env`:

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

Demo password: `Password123!` for the seeded accounts. Never use it outside local development.

## API conventions

Use `Authorization: Bearer <accessToken>` for authenticated endpoints. Merchant parcel creation accepts an `Idempotency-Key` header. Public tracking is available at `/api/v1/parcels/track/:trackingNumber`.
