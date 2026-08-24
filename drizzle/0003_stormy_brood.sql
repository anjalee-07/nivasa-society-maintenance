ALTER TABLE `complaint_photos` ADD `data` blob NOT NULL;--> statement-breakpoint
ALTER TABLE `complaint_photos` DROP COLUMN `object_key`;