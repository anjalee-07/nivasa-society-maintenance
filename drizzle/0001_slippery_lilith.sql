PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_complaints` (
	`id` text PRIMARY KEY NOT NULL,
	`public_id` text NOT NULL,
	`resident_id` text NOT NULL,
	`title` text NOT NULL,
	`category` text NOT NULL,
	`description` text NOT NULL,
	`location` text NOT NULL,
	`status` text DEFAULT 'Open' NOT NULL,
	`priority` text DEFAULT 'Medium' NOT NULL,
	`idempotency_key` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`resolved_at` text,
	FOREIGN KEY (`resident_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "complaints_status_check" CHECK("__new_complaints"."status" IN ('Open', 'In Progress', 'Resolved')),
	CONSTRAINT "complaints_priority_check" CHECK("__new_complaints"."priority" IN ('Low', 'Medium', 'High'))
);
--> statement-breakpoint
INSERT INTO `__new_complaints`("id", "public_id", "resident_id", "title", "category", "description", "location", "status", "priority", "idempotency_key", "version", "created_at", "updated_at", "resolved_at") SELECT "id", "public_id", "resident_id", "title", "category", "description", "location", "status", "priority", "idempotency_key", "version", "created_at", "updated_at", "resolved_at" FROM `complaints`;--> statement-breakpoint
DROP TABLE `complaints`;--> statement-breakpoint
ALTER TABLE `__new_complaints` RENAME TO `complaints`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_complaints_public_id` ON `complaints` (`public_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_complaints_resident_idempotency` ON `complaints` (`resident_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_complaints_resident_created` ON `complaints` (`resident_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_complaints_status_category_created` ON `complaints` (`status`,`category`,`created_at`);--> statement-breakpoint
CREATE TABLE `__new_notification_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`dedupe_key` text NOT NULL,
	`user_id` text NOT NULL,
	`email` text NOT NULL,
	`type` text NOT NULL,
	`subject` text NOT NULL,
	`body` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`sent_at` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "outbox_status_check" CHECK("__new_notification_outbox"."status" IN ('pending', 'sent', 'failed'))
);
--> statement-breakpoint
INSERT INTO `__new_notification_outbox`("id", "dedupe_key", "user_id", "email", "type", "subject", "body", "status", "attempts", "last_error", "created_at", "sent_at") SELECT "id", "dedupe_key", "user_id", "email", "type", "subject", "body", "status", "attempts", "last_error", "created_at", "sent_at" FROM `notification_outbox`;--> statement-breakpoint
DROP TABLE `notification_outbox`;--> statement-breakpoint
ALTER TABLE `__new_notification_outbox` RENAME TO `notification_outbox`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_outbox_dedupe` ON `notification_outbox` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `idx_outbox_status_created` ON `notification_outbox` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `__new_users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`flat_number` text,
	`phone` text,
	`role` text DEFAULT 'resident' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "users_role_check" CHECK("__new_users"."role" IN ('resident', 'admin'))
);
--> statement-breakpoint
INSERT INTO `__new_users`("id", "email", "name", "flat_number", "phone", "role", "created_at", "updated_at") SELECT "id", "email", "name", "flat_number", "phone", "role", "created_at", "updated_at" FROM `users`;--> statement-breakpoint
DROP TABLE `users`;--> statement-breakpoint
ALTER TABLE `__new_users` RENAME TO `users`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_users_email` ON `users` (`email`);