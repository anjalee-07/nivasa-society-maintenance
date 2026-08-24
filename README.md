# Nivasa - Society Maintenance Tracker

Nivasa is a full-stack maintenance workflow for apartment societies. Residents can raise complaints with supporting photos, follow a complete status timeline, and read community notices. Administrators get a prioritized queue, filters, overdue detection, dashboard reporting, notice publishing, and a reliable email outbox.

## Product capabilities

- Platform-backed identity with server-enforced `resident` and `admin` roles
- Resident profile onboarding and ownership-scoped complaint access
- Complaint creation with category, description, location, and optional image
- Append-only history for creation, priority changes, and status changes
- Closed `Resolved` state with optimistic concurrency protection
- Configurable overdue threshold calculated from server time
- Admin filters by text, status, overdue state, category, and age
- Pinned important notices and resident email fan-out
- Resend email integration with idempotent outbox records, background delivery, and backlog draining
- D1 relational persistence, with complaint photos stored privately as database blobs
- Responsive, keyboard-accessible resident and admin interfaces

## Local setup

Prerequisite: Node.js `>=22.13.0`.

1. Install dependencies with `npm install`.
2. Copy `.env.example` to `.env.local` and set any optional email/admin values. If a `.dev.vars` file also exists it takes precedence for worker bindings, and it is git-ignored, so prefer it for real provider keys.
3. Run `npm run db:generate` after changing `db/schema.ts`.
4. Start the application with `npm run dev`.

The local Cloudflare runtime creates an isolated D1 database automatically. Local development exposes a safe role switcher with seeded resident and admin accounts. Those demo fixtures are created only when `SEED_DEMO_DATA` is `true`, which the local Wrangler config sets for you; hosted deployments start empty. That switcher is accepted only on `localhost`; hosted requests require platform identity headers.

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `ADMIN_EMAILS` | Production | Comma-separated signed-in emails that receive the admin role. The list is authoritative: an email removed from it is demoted to `resident` on its next request, so deploying without this value leaves the society with no administrators |
| `TRUST_PLATFORM_IDENTITY` | Only behind a trusted proxy | Set to `1` to accept `oai-authenticated-user-*` identity headers. Unsafe anywhere the hosting layer does not strip those headers from inbound requests |
| `ADMIN_INVITE_CODE` | Optional | Shared code that lets a signed-in visitor claim the admin role at `/?admin=<code>`. Unset by default, which removes the route entirely. Intended for review access; remove it once review is complete |
| `RESEND_API_KEY` | For live email | Resend API key used by the notification outbox dispatcher |
| `EMAIL_FROM` | For live email | Verified sender, for example `Nivasa <notices@example.com>`. Required whenever `RESEND_API_KEY` is set; there is no default, because Resend rejects every unverified sender |
| `DEMO_RESIDENT_EMAIL` | Local demo only | Overrides the seeded resident's address. Resend's shared test sender delivers only to the account owner, so this lets a local preview receive real mail without putting a personal address in the source |

When email is not configured, complaint updates and important notices still commit successfully. Their messages remain `pending` in the admin delivery center with their retry budget untouched, so nothing is stranded by a configuration gap. After adding the provider settings, **Send all queued** in the delivery center works through the backlog oldest first.

Delivery never blocks a request. Committing a status change or notice hands the outbox to the runtime and responds immediately; the provider calls happen afterwards. Each drain processes up to 50 messages, so a society larger than one batch finishes across several drains, and the delivery center reports how many remain.

## Enabling email delivery

Email is optional to run the application and required to deliver resident
notifications. Both settings must be present together.

1. Create a Resend account and add your sending domain under **Domains**, then
   publish the DNS records Resend shows you and wait for the domain to verify.
   Without a verified domain Resend accepts only `onboarding@resend.dev`, which
   delivers exclusively to the address that owns the account.
2. Create an API key under **API Keys** with send permission.
3. Set `RESEND_API_KEY` and `EMAIL_FROM` in the environment. Locally use
   `.dev.vars`; on the hosted deployment set them as environment variables in
   your control plane. Never commit either value.
4. Restart the application and open **Email delivery** as an administrator. The
   red configuration banner disappears once both values are readable.
5. Choose **Send all queued** to deliver anything that accumulated while email
   was unconfigured. Queued messages keep their full retry budget, so nothing is
   lost by configuring the provider late.

If a message fails, the delivery center shows the provider's own error against
that message. A `403` naming the sender means `EMAIL_FROM` is not on a verified
domain; a `401` means the API key is wrong.

## Deploying to Cloudflare

The application depends on Workers and D1, so it cannot run on Vercel, Render,
or Railway without replacing its database layer. Deploying to Cloudflare keeps
those primitives and needs no code changes. R2 is not required: complaint photos
are stored in D1, so no object storage has to be enabled on the account.

A free Cloudflare account is sufficient.

1. Authenticate: `npx wrangler login`
2. Create the database, then note the id it prints:

   ```
   npx wrangler d1 create nivasa-db
   ```

3. Build and deploy with those resources. The build writes a complete
   `dist/server/wrangler.json`, so the identifiers are supplied at build time
   rather than committed:

   ```
   CF_D1_DATABASE_ID=<id> CF_D1_DATABASE_NAME=nivasa-db npm run deploy
   ```

   On Windows PowerShell, set the variables with `$env:NAME = "value"` first.

4. Add the secrets. Each command prompts for the value, which is never written
   to disk:

   ```
   npm run cf:secrets ADMIN_EMAILS
   npm run cf:secrets RESEND_API_KEY
   npm run cf:secrets EMAIL_FROM
   npm run cf:secrets ADMIN_INVITE_CODE
   ```

5. Redeploy so the secrets take effect, then open the printed `workers.dev` URL.

The schema creates itself on first request, including columns added after an
earlier deployment, so no migration step is required. Generated migrations are
kept under `drizzle/` for reference.

Pass `SEED_DEMO_DATA=false` at build time to deploy an empty society. The
default populates the demo fixtures, which is usually what you want for a
walkthrough.

## Reviewer access

Hosted visitors authenticate through the platform, and the role always comes
from the server. A reviewer who is not listed as an administrator therefore sees
only the resident half of the application, which hides the dashboard, filters,
priority handling, overdue queue, notice publishing, and delivery centre.

Two ways to grant access:

1. **Preferred.** Add the reviewer's signed-in email to `ADMIN_EMAILS`. They
   become an administrator the next time they load the page.
2. **When the address is not known in advance.** Set `ADMIN_INVITE_CODE` to a
   long random string and share `https://your-deployment/?admin=<code>`. The
   page redeems the code once, removes it from the address bar, and reloads with
   administrator access. The grant is recorded against that user, so it survives
   the per-request re-sync from `ADMIN_EMAILS`.

With `ADMIN_INVITE_CODE` unset the route returns `404` and cannot be probed.
Remove the value once review is finished; existing grants stay in place and can
be revoked by clearing `admin_granted` for that user.

## Authentication and roles

Residents register with an email and password. Passwords are hashed with
PBKDF2-SHA256 using a per-user salt, and a session is a random 256-bit token held
in an `HttpOnly`, `SameSite=Lax` cookie. Sessions are stored server side, so
signing out revokes access immediately rather than relying on the client to
discard a cookie.

The server never trusts a browser-supplied role. A user whose email appears in
`ADMIN_EMAILS` becomes an administrator; everyone else is a resident. The stored
role is re-synchronised from the allowlist on every request, so revoking access
is a configuration change rather than a database edit.

Some hosting platforms authenticate visitors themselves and inject identity
headers. Nivasa accepts those **only** when `TRUST_PLATFORM_IDENTITY=1`, because
any caller can set such headers unless a proxy strips them from inbound
requests. Leaving it unset means a deployment on ordinary infrastructure fails
closed rather than accepting an attacker-supplied identity. Do not set it unless
your platform guarantees that stripping.

Every protected API resolves identity on the server. Resident complaint and photo reads are ownership-scoped. Admin-only mutations re-check the stored role, so hiding a control in the interface is never the authorization boundary.

## Complaint workflow

`Open` complaints may move to `In Progress` or directly to `Resolved`. `In Progress` may move only to `Resolved`. `Resolved` is terminal and the API rejects later status or priority edits. Each update requires the record version last read by the administrator; a stale version receives HTTP `409` instead of silently overwriting a concurrent change.

An unresolved complaint is overdue when:

```text
server_now - created_at >= configured_overdue_days
```

Resolved complaints are never overdue. Changing the threshold immediately recalculates every dashboard and queue result; overdue is derived data, not a manually editable status.

## API reference

All JSON errors use `{ "error": "human-readable message" }`. Protected routes return `401` without identity and `403` for the wrong role.

| Method | Route | Role | Purpose |
| --- | --- | --- | --- |
| `POST` | `/api/auth` | Public | Register, sign in, or sign out via an `action` field |
| `GET` | `/api/bootstrap` | Signed in | Profile, scoped complaints/history/photos, notices, metrics, settings, delivery activity |
| `PATCH` | `/api/profile` | Signed in | Complete or update name, flat number, and phone |
| `POST` | `/api/complaints` | Resident | Multipart complaint creation; optional `photo`, max 2 MB |
| `PATCH` | `/api/complaints` | Admin | Update status/priority with `expectedVersion` and optional note |
| `GET` | `/api/photos/:id` | Owner/Admin | Return a validated private complaint image to its owner or an administrator |
| `POST` | `/api/notices` | Admin | Publish a notice and fan out email records when important |
| `DELETE` | `/api/notices` | Admin | Remove a notice from the board |
| `PATCH` | `/api/settings` | Admin | Set the overdue threshold from 1 to 60 days |
| `POST` | `/api/notifications` | Admin | Retry one outbox message by `id`, or omit `id` to drain the queued backlog |
| `GET` | `/api/health` | Public | Database readiness check |

### Complaint creation payload

`multipart/form-data`: `title`, `category`, `description`, `location`, `idempotencyKey`, and optional `photo`. Supported images are genuine JPEG, PNG, or WebP files. The server inspects file signatures rather than trusting the supplied MIME type.

### Admin update payload

```json
{
  "id": "complaint-uuid",
  "status": "In Progress",
  "priority": "High",
  "note": "Technician assigned for this afternoon.",
  "expectedVersion": 2
}
```

## Database schema

| Table | Responsibility |
| --- | --- |
| `users` | Stable identity, contact profile, and server-owned role |
| `settings` | Society configuration including `overdue_days` |
| `complaints` | Current complaint projection, lifecycle, owner, idempotency key, and version |
| `complaint_history` | Append-only creation/status/priority audit events with actor, note, and timestamp |
| `complaint_photos` | Complaint image bytes, their metadata, and the ownership link |
| `notices` | Published notices with important/pinned classification |
| `sessions` | Server-side sessions with owner and expiry |
| `notification_outbox` | Idempotent resident emails, attempts, delivery state, and provider error |

Indexes cover resident timelines, admin status/category filtering, complaint histories, notice pinning, and outbox retries. Foreign keys preserve ownership and audit attribution. Generated migrations live under `drizzle/`.

## Validation and testing

- `npm run build` - production worker/client build
- `npm run lint` - TypeScript, React, and accessibility lint rules
- `npm test` - production build plus rendered application and capability checks
- `npm run test:api` - 36 integration tests against the real worker
- `npm run test:all` - both suites

`test:api` starts the development worker with its own D1 binding, because
the route handlers depend on the Cloudflare runtime and cannot be exercised by
importing the built bundle. It runs with `EMAIL_DELIVERY_DISABLED=1`, so a test
run exercises the whole outbox without ever contacting the email provider. Each
run starts from a clean local database.

The suite covers role enforcement on every protected route, ownership scoping,
complaint validation including photo signature checks, the full status
lifecycle and its rejected transitions, optimistic concurrency under a stale
version, overdue derivation across threshold changes, dashboard reconciliation,
notice pinning, and outbox behaviour when the provider is unavailable.

The API validates text lengths, enums, photo signatures/sizes, ownership, role, lifecycle transitions, idempotency keys, and optimistic versions. See [docs/system-design.md](docs/system-design.md) for the architecture and failure-handling rationale.
