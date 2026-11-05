CREATE TABLE `program_break_marker` (
	`program_id` text PRIMARY KEY NOT NULL,
	`offsets_ms` text NOT NULL,
	`detector` text NOT NULL,
	`imported_at` integer NOT NULL,
	FOREIGN KEY (`program_id`) REFERENCES `program`(`uuid`) ON UPDATE no action ON DELETE cascade
);
