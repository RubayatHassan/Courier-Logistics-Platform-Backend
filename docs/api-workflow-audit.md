# API relationship and workflow audit

Audit date: 2026-10-03. Scope: every mounted router, its services/middleware, Prisma relationships, server/serverless entry points, seed data, and API examples. This is a source review plus local regression testing, not a production certification.

## Result

The implemented parcel flow is now more consistent and has regression coverage. The full ERD is substantially larger than the implemented API. Production readiness still requires the missing financial workflows, deployment work and real-service verification described below.

No production API requests, payments, database migrations, seeds, deployment or data cleanup were performed.

## Step-by-step API dependencies

All API paths below start with `/api/v1`. ADMIN operations also allow SUPER_ADMIN. Use the access token of the actor shown, not one token for the whole workflow.

| Step | Actor / API | Input from previous steps | Result and next dependency |
| --- | --- | --- | --- |
| 1 | Public `POST /auth/register` | email, password, name; merchantName for merchant registration | Pending registration in Redis for 15 minutes; no User yet. SMTP verification code/link required. |
| 2 | Public `POST /auth/verify-email` or verification GET link | email + code, or token | Transaction creates Merchant (if requested) and verified User. |
| 3 | Public `POST /auth/login` | verified account credentials | Access token + HttpOnly refresh cookie. `/auth/refresh` consumes the old refresh token atomically; `/auth/logout` revokes that session. |
| 4 | Admin `POST /operations/branches` | name, code, type | branchId for hubs and manager scope. `GET /operations/branches` retrieves active branches. |
| 5 | Admin `POST /operations/hubs` | name, code, address, city, branchId; optional merchantId | originHubId and destinationHubId. A branch is needed for hub-manager access. Merchant hubs must match the parcel's merchant; shared hubs have merchantId=null. |
| 6 | Admin `POST /operations/hub-managers` | branchId, identity and password | User(role=HUB_MANAGER) + UserBranch created atomically. Repeat for a different destination branch when needed. |
| 7 | Admin `POST /operations/riders` | destinationHubId as hubId, identity and password | User(role=RIDER) + Rider. Manager/admin `GET /operations/riders?hubId=...` returns available active rider IDs in scope. |
| 8 | Admin `POST /operations/vehicles` | type, plateNumber, optional capacityKg | Optional vehicleId for transfer; hub managers can list active vehicles. |
| 9 | Merchant/admin `POST /customers` | name, phone, optional email; admin supplies merchantId | customerId belongs to one merchant. `GET /customers` uses the same merchant scope. |
| 10 | Merchant/admin `POST /parcels` | customerId, pickup/delivery addresses, weightGrams, codAmount; admin supplies merchantId | Parcel(CREATED), tracking event and positive COD payment created in one transaction. Reuse the same Idempotency-Key only with the same payload. Save parcelId/trackingNumber. |
| 11 | Merchant/admin `POST /parcels/:id/assign-origin-hub` | parcelId + originHubId | CREATED (or legacy PICKED_UP) → AT_HUB, currentHubId set, event recorded; branch managers receive notifications. This is the currently supported direct hub drop-off flow. |
| 12 | Origin manager/admin `POST /parcels/:id/dispatch` | destinationHubId; optional vehicleId | AT_HUB → IN_TRANSIT; creates HubTransfer(fromHubId,toHubId). Current hub remains origin until arrival. Destination must differ. |
| 13 | Destination manager/admin `POST /parcels/:id/mark-arrived` | parcelId with latest transfer | IN_TRANSIT → AT_HUB; currentHubId becomes destination. Destination UserBranch scope is checked. |
| 14 | Destination manager/admin `POST /parcels/:id/assign-rider` | riderId from that hub | AT_HUB/SORTING/DELIVERY_FAILED/RESCHEDULED → OUT_FOR_DELIVERY. Old active assignments close; one new assignment is created. No extra OUT_FOR_DELIVERY status PATCH is needed. |
| 15a | Optional customer `POST /payments/stripe/customer-checkout` | trackingNumber + recipient phone, parcel OUT_FOR_DELIVERY | Returns checkout URL; pending online payment prevents delivery and terminal closure. Merchant/admin can use `/payments/stripe/checkout` with parcelId before closure. |
| 15b | Stripe `POST /payments/stripe/webhook` | signed raw body | Completed/async-success with paid status → PAID after amount, currency and parcel checks; pending COD is disabled. Expired/async-failed → FAILED so another checkout can be started. Duplicate events do not repeat side effects. |
| 16 | Assigned rider/admin `PATCH /parcels/:id/status` | status=DELIVERED | OUT_FOR_DELIVERY → DELIVERED, deliveredAt set, assignment completed. With unpaid COD, exactly one pending COD payment must be collected and a COD_COLLECTED ledger entry is created. Already-paid online payments never create COD collection. Zero-COD parcels require no payment. |
| 17 | Public `GET /parcels/track/:trackingNumber` | trackingNumber | Limited tracking fields and history; cached up to 30 seconds. |

Same-hub delivery can skip dispatch/arrival and assign a rider directly at step 11's hub. The current demo seed places the rider at the destination hub, so its example uses a transfer.

## Failure and alternative paths

- `OUT_FOR_DELIVERY → DELIVERY_FAILED` closes the failed assignment. The manager can directly assign a new rider, creating a separate delivery attempt. Manager/admin can explicitly set RESCHEDULED first or mark RETURNED. A rider with only completed assignments loses mutation access.
- Sorting is optional at a hub. SORTING parcels can be dispatched to another hub or assigned to a local rider.
- `OUT_FOR_DELIVERY → RESCHEDULED` also closes the assignment; the next delivery requires manager assignment.
- Merchant cancellation is limited by the state machine to CREATED/PICKUP_ASSIGNED. Delivered/cancelled/returned/lost parcels cannot be reset through origin assignment.
- Generic status PATCH cannot manufacture hub transfers, arrival or rider/pickup assignments. Those transitions require dedicated operational endpoints. Pickup booking/assignment is still missing, so the new supported flow starts with hub drop-off; old pickup states are retained for compatibility.
- Terminal closure with an unresolved positive online payment returns 409. Visiting the payment cancel page does not prove that the provider session was cancelled. Wait for provider failure/expiry or reconcile it before closing the parcel.
- A retry of an open checkout returns the existing provider URL. A network failure keeps the same durable payment ID and provider idempotency key. An unbound session older than 23 hours requires operator reconciliation before retry, avoiding reuse after Stripe's minimum retention window.
- Online-paid returns/cancellations are not refunded automatically; refund operations remain unimplemented. Financial operators must not interpret parcel status as proof of a completed refund.
- `GET/PATCH /auth/me` read/update the authenticated profile. Admin creation is SUPER_ADMIN-only. Google login verifies the Google token and links/creates a customer account. Password reset atomically consumes the reset record, changes the password and revokes refresh tokens.

## Defects fixed

| Area | Observed defect | Change |
| --- | --- | --- |
| Hub creation | Branch-only type/email/phone fields were forwarded to the Hub model | Dedicated Hub input schema matching Prisma |
| Merchant booking | Admin had no way to specify merchant context | Admin merchantId accepted; merchant users remain bound to their own context |
| Booking retries | Concurrent identical idempotency keys failed on uniqueness conflict | Recover the winning booking and compare the original payload |
| Workflow integrity | Origin assignment could resurrect closed parcels | Restrict lifecycle and allow origin assignment once |
| Concurrency | Dispatch/arrival/assignment used unconditional writes | Transactional compare-and-set on status and updatedAt; fail before related records are added |
| Rider authorization | Historical assignment granted mutation access indefinitely | Require an active assignment and active rider; complete attempts on closure/failure |
| Redelivery | Sorting/failed/rescheduled parcels could not be assigned a rider | Explicit assignment path with a new attempt |
| Zero COD | Booking created a zero-value ONLINE/PENDING row that blocked delivery | No payment created for zero COD; delivery ignores legacy zero-value online rows |
| Payment races | Parallel checkout could create multiple provider sessions; checkout allowed after delivery | Parcel row lock, durable reservation, provider idempotency key and terminal-state guard |
| Payment lifecycle | Only immediate success was handled; expiry blocked future checkout | Handle async success/failure and expiry; amount/currency check and duplicate-event guard |
| COD accounting | Online payment and COD could remain independently collectable | Successful online payment disables pending COD; delivery requires one collectable COD row |
| Payment landing page | Visiting GET success performed payment writes | Read-only local confirmation page |
| Refresh tokens | JWTs could be identical in one second; bcrypt truncates long tokens; rotation not atomic | Random JWT ID, SHA-256 fingerprint, exact-hash atomic consumption and configured expiry |
| Authentication resilience | Database errors were mislabeled 401; Redis connection/resend behavior was inconsistent | Separate token errors from DB errors, shared connection promise, explicit resend connection |
| Abuse protection | Verification/reset/login lacked attempt limits | Atomic Redis counters per endpoint/IP and email; fail closed with 503 if unavailable |
| Input/error handling | Invalid JSON surfaced as 500; price precision unbounded | 400/413 parser errors, two-decimal COD bound and validated workflow UUIDs |
| Mail | Production without SMTP logged secret-bearing previews; names were interpolated into HTML | Production requires SMTP; escape names/links in email markup |
| API discovery/examples | Merchant/manager lacked required lookup access; demo attempted payment after delivery | Scoped lookup routes and corrected sequential example |

## Remaining production work — not implemented or verified

| Priority | Gap | Required outcome |
| --- | --- | --- |
| P1 | No baseline Prisma migration history; only one manual SQL change exists | Baseline the deployed schema with a reviewed migration plan, then verify deploy/rollback on a database copy. `prisma validate` does not prove a deployed DB matches. |
| P1 | Parcel and Order/Shipment are parallel models without synchronized workflows | Choose the canonical shipment aggregate, implement booking/order/assignment/payment synchronization, and migrate existing records. Do not assume an ERD relation creates an API process. |
| P1 | Settlement/invoice/refund/claim APIs absent | Define delivery-fee deductions, COD custody, payout reconciliation, settlement periods, partial/full refunds, disputes and idempotent financial posting. DeliveryCharge is calculated but not posted as a ledger deduction. |
| P1 | Existing production data may contain duplicate/stale payments, assignments or transfers | Run a read-only reconciliation report and approve data repair before rollout. No existing data was changed in this audit. |
| P1 | No real PostgreSQL/Redis/Stripe concurrency tests | Exercise simultaneous booking, checkout-vs-delivery, dispatch, assignment, refresh reuse, transaction rollback and duplicate/delayed webhook delivery against isolated services. Current mocks do not model SQL isolation or rollback. |
| P1 | Super-admin bootstrap only runs in `src/server.ts`; Vercel imports `api/index.ts` | Provision the first super admin through a controlled deployment step; review existing-account promotion and initial credentials. Do not rely on server startup code in serverless. |
| P1 | Notifications have records but no reliable worker/outbox flow | Implement queued sending, retry/dead-letter behavior and operator visibility; verification/reset email delivery failure also needs retry guarantees. |
| P2 | Pickup workflow/proof of delivery missing | Add pickup assignment and receipt, evidence/OTP/signature for delivery, return receipt and exception ownership. Origin assignment currently represents a direct hub drop-off. |
| P2 | Authentication/account model hardening incomplete | Access JWTs remain valid until expiry after reset/logout; decide tokenVersion/session invalidation policy. Add verification/register/reset end-to-end tests, password byte-length policy, account lifecycle and admin audit coverage. |
| P2 | Proxy/rate-limit deployment configuration | Configure trusted proxy topology and verify distinct client IPs. Current forwarded headers are not trusted; behind an unconfigured proxy, callers may share an IP bucket. Public tracking/customer checkout need deployment-level abuse controls. |
| P2 | Lookup/list/inbound queue completeness | Add cursor pagination to customers/vehicles and paged navigation to capped lookup endpoints; add scoped incoming-transfer queues and a notification API. Destination managers currently need parcel IDs from an external handoff. |
| P2 | Incomplete schema relationships | Review loose roleId/addressId/documentId/tagId fields, duplicated ServiceType/ServiceTypeRecord, merchant/account ownership and required-vs-nullable relationships. Add DB uniqueness for one active assignment/payment where appropriate after existing-data reconciliation. |
| P2 | Operational readiness | Add CI, OpenAPI contract, dependency/security scans, load tests, structured/redacted logs, graceful shutdown, DB pool settings, backup/restore checks, and readiness coverage for Redis. Current `/ready` checks only the DB. |

## Verification and rollout

Local result: 44 tests passed across 4 files; TypeScript build passed; Prisma schema validation passed; repository lint passed with only the pre-existing Biome configuration deprecation notice. Changed source files passed Biome checks, and `git diff --check` passed.

Run `npm test`, `npm run build`, `npm run lint:check`, and `npx prisma validate`. The regression suite runs Express routes through Supertest with fake Prisma/Redis/Stripe; it uses test credentials and does not contact configured production services. Tests cover the complete direct-hub COD sequence plus negative authorization, stale-write guards, retry, signature, amount and token cases. Pricing tests now call production pricing code rather than copying the formula.

Before deployment:

1. Confirm PostgreSQL schema and required manual vehicle-transfer migration; this code update itself adds no schema fields.
2. Set up reachable Redis and production SMTP. Authentication now fails closed when its Redis protection is unavailable.
3. Expect one-time re-login for refresh sessions stored with the previous bcrypt hash format.
4. Subscribe Stripe to completed, async_payment_succeeded, async_payment_failed and expired checkout events; verify signatures with the actual endpoint secret in a test account.
5. Reconcile old data and test concurrent requests on a disposable environment. Resolve pending checkout sessions before closing their parcels.
6. Complete the P1 financial/deployment gaps before claiming full production readiness.

Provider references: [Stripe idempotent requests](https://docs.stripe.com/api/idempotent_requests) and [Checkout session lifecycle](https://docs.stripe.com/api/checkout/sessions). Stripe keys may be pruned after at least 24 hours; reuse within retention returns the stored response, including errors. The implementation therefore retains the local reservation through ambiguous failures.
