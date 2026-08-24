import { sql } from "drizzle-orm";
import {
  blob,
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    flatNumber: text("flat_number"),
    phone: text("phone"),
    role: text("role", { enum: ["resident", "admin"] })
      .notNull()
      .default("resident"),
    // Set when the role came from the invite code rather than ADMIN_EMAILS, so
    // the per-request allowlist re-sync does not revoke it.
    adminGranted: integer("admin_granted", { mode: "boolean" })
      .notNull()
      .default(false),
    // Null for platform and demo identities, which authenticate elsewhere.
    passwordHash: text("password_hash"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("idx_users_email").on(table.email),
    check("users_role_check", sql`${table.role} IN ('resident', 'admin')`),
  ],
);

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const complaints = sqliteTable(
  "complaints",
  {
    id: text("id").primaryKey(),
    publicId: text("public_id").notNull(),
    residentId: text("resident_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    category: text("category").notNull(),
    description: text("description").notNull(),
    location: text("location").notNull(),
    status: text("status", { enum: ["Open", "In Progress", "Resolved"] })
      .notNull()
      .default("Open"),
    priority: text("priority", { enum: ["Low", "Medium", "High"] })
      .notNull()
      .default("Medium"),
    idempotencyKey: text("idempotency_key").notNull(),
    version: integer("version").notNull().default(1),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    resolvedAt: text("resolved_at"),
  },
  (table) => [
    uniqueIndex("idx_complaints_public_id").on(table.publicId),
    uniqueIndex("idx_complaints_resident_idempotency").on(
      table.residentId,
      table.idempotencyKey,
    ),
    index("idx_complaints_resident_created").on(
      table.residentId,
      table.createdAt,
    ),
    index("idx_complaints_status_category_created").on(
      table.status,
      table.category,
      table.createdAt,
    ),
    check(
      "complaints_status_check",
      sql`${table.status} IN ('Open', 'In Progress', 'Resolved')`,
    ),
    check(
      "complaints_priority_check",
      sql`${table.priority} IN ('Low', 'Medium', 'High')`,
    ),
  ],
);

export const complaintHistory = sqliteTable(
  "complaint_history",
  {
    id: text("id").primaryKey(),
    complaintId: text("complaint_id")
      .notNull()
      .references(() => complaints.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    fromValue: text("from_value"),
    toValue: text("to_value").notNull(),
    actorId: text("actor_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    actorName: text("actor_name").notNull(),
    note: text("note"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("idx_history_complaint_created").on(
      table.complaintId,
      table.createdAt,
    ),
  ],
);

export const complaintPhotos = sqliteTable(
  "complaint_photos",
  {
    id: text("id").primaryKey(),
    complaintId: text("complaint_id")
      .notNull()
      .references(() => complaints.id, { onDelete: "cascade" }),
    data: blob("data").notNull(),
    originalName: text("original_name").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("idx_photos_complaint").on(table.complaintId)],
);

export const notices = sqliteTable(
  "notices",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    important: integer("important", { mode: "boolean" }).notNull().default(false),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    authorName: text("author_name").notNull(),
    publishedAt: text("published_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("idx_notices_important_published").on(
      table.important,
      table.publishedAt,
    ),
  ],
);

export const notificationOutbox = sqliteTable(
  "notification_outbox",
  {
    id: text("id").primaryKey(),
    dedupeKey: text("dedupe_key").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    email: text("email").notNull(),
    type: text("type").notNull(),
    subject: text("subject").notNull(),
    body: text("body").notNull(),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    sentAt: text("sent_at"),
  },
  (table) => [
    uniqueIndex("idx_outbox_dedupe").on(table.dedupeKey),
    index("idx_outbox_status_created").on(table.status, table.createdAt),
    check(
      "outbox_status_check",
      sql`${table.status} IN ('pending', 'sent', 'failed')`,
    ),
  ],
);

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    expiresAt: text("expires_at").notNull(),
  },
  (table) => [
    index("idx_sessions_user").on(table.userId),
    index("idx_sessions_expires").on(table.expiresAt),
  ],
);
