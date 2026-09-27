DROP INDEX IF EXISTS `execution_parked`;
--> statement-breakpoint
CREATE INDEX `execution_parked` ON `execution` (`status`) WHERE `execution`.`status` in ('waiting','awaiting_approval','awaiting_review');
