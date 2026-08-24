# Nivasa system design

Nivasa is a Cloudflare-compatible full-stack application built around D1 for structured records and R2 for private image objects. The frontend consumes route-handler APIs; every API resolves the authenticated platform user on the server and derives the role from stored data plus the configured admin email allowlist. Residents are always scoped to their own complaint and photo records. Admin mutations perform a second server-side role check.

## Complaint history model

`complaints` is the current projection used for fast lists and dashboard counts. It stores owner, category, current status and priority, timestamps, an idempotency key, and an integer version. `complaint_history` is an append-only event stream. Creation records an `Open` event; later status or priority changes capture the previous value, next value, actor ID/name, timestamp, and optional note. Keeping the projection and events separate makes admin filtering inexpensive while preserving a trustworthy resident timeline.

The accepted lifecycle is `Open -> In Progress -> Resolved`, with a permitted direct `Open -> Resolved` path for simple fixes. `Resolved` is terminal. The API rejects repeated or backward transitions and refuses any mutation after closure. Admin updates include the version last read. The update succeeds only if that version is still current; otherwise it returns a conflict so two administrators cannot silently overwrite each other.

## Overdue detection

The threshold is a persisted integer setting from 1 to 60 days. Overdue is deliberately derived at read time using the D1 server clock: an unresolved complaint is overdue when the difference between `now` and `created_at` reaches the configured number of days. Resolved complaints are excluded. This avoids stale flags and means a settings change is reflected immediately in sorting, filters, and metrics. Admin queues sort overdue requests first, then priority, then creation time.

## Photo handling

The browser sends at most one optional image in a multipart request. The API limits the file to 5 MB and verifies JPEG, PNG, or WebP signatures from the bytes rather than trusting the filename or client MIME type. It creates a non-guessable R2 key containing the owner and complaint IDs, writes the object, and stores only metadata in `complaint_photos`. If the database write fails, the just-uploaded object is deleted to avoid an orphan.

R2 objects are never exposed as public bucket URLs. `/api/photos/:id` joins photo metadata to its complaint, authorizes the current resident owner or an administrator, then streams the object with a private cache policy and `nosniff` protection.

## Notification flow

A status change creates an idempotent `notification_outbox` row keyed by complaint and version. An important notice creates one row per registered resident, keyed by notice and recipient. The complaint or notice transaction remains successful even when the provider is unavailable. The dispatcher attempts delivery through Resend with the outbox ID as the provider idempotency key, then records `sent` or `failed`, attempt count, timestamp, and a bounded error message. Without provider configuration, messages remain `pending` and are visible in the admin delivery center for retry.

Delivery is deliberately kept off the request path. The route commits the outbox rows and hands draining to the runtime, so an administrator saving a status change never waits on a third-party API, and a fan-out to many residents cannot exhaust one invocation. A drain walks queued and retryable messages oldest first in a bounded batch, and stops early when the provider is unconfigured, since every remaining message would report the same gap. A missing sender address is treated as configuration rather than a delivery attempt, so a message keeps its full retry budget until the provider can actually accept it. An explicit administrator retry overrides the attempt ceiling, because that is a deliberate decision rather than an automatic loop.

This outbox design prevents duplicate mail on browser retries, preserves an audit trail, and keeps email failure from rolling back real maintenance work. Important notices are sorted before ordinary notices using an indexed `(important, published_at)` path, so pinned information remains deterministic.

## Reporting and operations

Dashboard metrics are calculated from the same authorized complaint result used by the queue, ensuring counts reconcile with visible records. D1 indexes support resident timelines, status/category filters, histories, and outbox retries. A health endpoint checks database readiness. Generated migrations, runtime schema guards, strict API validation, optimistic concurrency, upload cleanup, and provider retry state make the application safe to operate while keeping the architecture small enough for a society team to maintain.
