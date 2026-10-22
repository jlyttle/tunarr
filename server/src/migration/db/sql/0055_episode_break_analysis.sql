CREATE TABLE `program_break_analysis` (
  `uuid` text PRIMARY KEY NOT NULL,
  `program_id` text REFERENCES `program`(`uuid`) ON DELETE CASCADE,
  `program_version_id` text REFERENCES `program_version`(`uuid`) ON DELETE CASCADE,
  `media_file_id` text REFERENCES `program_media_file`(`uuid`) ON DELETE CASCADE,
  `source_fingerprint` text NOT NULL,
  `detector_version` text NOT NULL,
  `config_hash` text NOT NULL,
  `status` text NOT NULL,
  `created_at` integer NOT NULL,
  `lease_expires_at` integer,
  `claim_key` text,
  `result` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `program_break_analysis_claim` ON `program_break_analysis` (`claim_key`);
--> statement-breakpoint
CREATE INDEX `program_break_analysis_program` ON `program_break_analysis` (`program_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX `program_break_analysis_cache` ON `program_break_analysis` (`source_fingerprint`, `detector_version`, `config_hash`);
--> statement-breakpoint
CREATE TABLE `break_detector_qualification` (
  `config_hash` text NOT NULL,
  `detector_version` text NOT NULL,
  `evaluation_hash` text NOT NULL,
  `dataset_id` text NOT NULL,
  `acknowledged_by` text NOT NULL,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `break_detector_qualification_version` ON `break_detector_qualification` (`detector_version`, `config_hash`);
