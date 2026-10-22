ALTER TABLE `transcode_config` ADD `aspect_ratio_mode` text DEFAULT 'preserve' NOT NULL;--> statement-breakpoint
UPDATE `transcode_config` SET `aspect_ratio_mode` = (SELECT `p`.`aspect_ratio_mode` FROM `__preserved_aspect_ratio_mode` `p` WHERE `p`.`uuid` = `transcode_config`.`uuid`) WHERE `uuid` IN (SELECT `uuid` FROM `__preserved_aspect_ratio_mode`);--> statement-breakpoint
DROP TABLE `__preserved_aspect_ratio_mode`;
