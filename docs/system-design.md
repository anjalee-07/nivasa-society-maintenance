# Nivasa system design

Nivasa is a Cloudflare-compatible application built on D1 for both structured records and private complaint images. Every API resolves the caller on the server and derives the role from stored data plus the admin email allowlist. Residents are scoped to their own complaints and photos; admin mutations re-check the role server side.

## Authentication

Residents register with an email and password, stored as PBKDF2-SHA256 with a per-user salt. The work factor is 10,000 iterations, below current guidance: the host allows 10ms of CPU per request, and a stronger factor cannot finish one. Each hash records its own iteration count, so the factor can be raised on a larger tier without invalidating existing passwords. A session is a random 256-bit token in an `HttpOnly`, `SameSite=Lax` cookie; the user and expiry live in `sessions`, so signing out revokes access immediately. Sign-in answers identically for an unknown address and a wrong password.

Identity headers injected by a hosting platform are trusted only when `TRUST_PLATFORM_IDENTITY` is set, because any caller can forge them unless a proxy strips them from inbound requests. Defaulting to distrust makes a deployment on ordinary infrastructure fail closed rather than accept an attacker-supplied identity.

## Complaint history model

`complaints` is the current projection used for fast lists and dashboard counts. It stores owner, category, current status and priority, timestamps, an idempotency key, and an integer version. `complaint_history` is an append-only event stream. Creation records an `Open` event; later status or priority changes capture the previous value, next value, actor ID/name, timestamp, and optional note. Keeping the projection and events separate makes admin filtering inexpensive while preserving a trustworthy resident timeline.

The accepted lifecycle is `Open -> In Progress -> Resolved`, with a permitted direct `Open -> Resolved` path for simple fixes. `Resolved` is terminal. The API rejects repeated or backward transitions and refuses any mutation after closure. Admin updates include the version last read. The update succeeds only if that version is still current; otherwise it returns a conflict so two administrators cannot silently overwrite each other.

## Overdue detection

The threshold is a persisted setting from 1 to 60 days. Overdue is derived at read time from the D1 server clock: an unresolved complaint is overdue once `now - created_at` reaches the configured days. Resolved complaints are excluded. This avoids stale flags, so a settings change is reflected immediately in sorting, filters, and metrics. Admin queues sort overdue first, then priority, then creation time.

## Photo handling

The browser sends at most one optional image in a multipart request. The API verifies JPEG, PNG, or WebP signatures from the bytes rather than trusting the filename or client MIME type, so a renamed executable is rejected before anything is stored. Images are held as a `BLOB` in `complaint_photos` beside their metadata. D1 refuses values past roughly two megabytes, so the API enforces a 2 MB limit and returns `413` rather than surfacing a database error.

Keeping bytes in the database puts the photo write in the same batch as the complaint and its history event, so the upload commits or fails as a unit and no compensating delete is needed. The trade-off is a firmer size ceiling; object storage would suit larger or more numerous photos.

Images are never served from a public path. `/api/photos/:id` joins the photo to its complaint, authorizes the resident owner or an administrator, and only then returns the bytes, with a private cache policy and `nosniff` protection.

## Notification flow

A status change creates an idempotent `notification_outbox` row keyed by complaint and version. An important notice creates one row per registered resident, keyed by notice and recipient. The complaint or notice transaction remains successful even when the provider is unavailable. The dispatcher attempts delivery through Resend with the outbox ID as the provider idempotency key, then records `sent` or `failed`, attempt count, timestamp, and a bounded error message. Without provider configuration, messages remain `pending` and are visible in the admin delivery center for retry.

Delivery is kept off the request path: the route commits the outbox rows and hands draining to the runtime, so an administrator never waits on a third-party API and a large fan-out cannot exhaust one invocation. A drain walks queued and retryable messages oldest first in a bounded batch. Missing provider configuration is treated as configuration rather than a failed attempt, so a message keeps its full retry budget; an explicit administrator retry overrides the attempt ceiling.

The outbox prevents duplicate mail, preserves an audit trail, and keeps email failure from rolling back maintenance work.

## Reporting and operations

Dashboard metrics come from the same authorized complaint result as the queue, so counts reconcile with visible records. Indexes support resident timelines, status and category filters, histories, and outbox retries, and a health endpoint checks database readiness. Runtime schema guards, strict validation, and optimistic concurrency keep the application safe to operate while small enough for a society team to maintain.
