# Courier & Logistics Platform API

Industry-oriented modular monolith for merchant parcel booking, hub operations, rider delivery, tracking and COD settlement.

The Prisma schema also contains the full relational ERD layer: users/roles/sessions, orders/shipments/items, addresses and master data, assignments/riders/vehicles/locations, payment methods/invoices, notifications/templates/logs, returns/refunds/claims, audit/system settings, and the requested many-to-many junction tables.

## Run locally

1. Copy `.env.example` to `.env`.
2. Start infrastructure: `docker compose up -d`.
3. Install dependencies: `npm install`.
4. Generate Prisma client: `npm run db:generate`.
5. Apply schema: `npx prisma migrate dev --name init`.
6. Seed demo users: `npm run db:seed`.
7. Start API: `npm run dev`.

The API is available at `http://localhost:4000`. OpenAPI JSON is at `/api/v1/openapi.json`.

After changing `prisma/schema.prisma`, run `npx prisma migrate dev --name <change-name>` to create and apply a migration against the local PostgreSQL container.

Demo password: `Password123!` for the seeded accounts. Never use it outside local development.

## API conventions

Use `Authorization: Bearer <accessToken>` for authenticated endpoints. Merchant parcel creation accepts an `Idempotency-Key` header. Public tracking is available at `/api/v1/parcels/track/:trackingNumber`.
