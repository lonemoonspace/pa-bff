CREATE TABLE `devices` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`role` text,
	`token_hash` text,
	`push_token_ct` text,
	`push_token_iv` text,
	`created_at` text,
	`last_seen_at` text,
	`revoked_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `devices_token_hash_unique` ON `devices` (`token_hash`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`name` text PRIMARY KEY NOT NULL,
	`next_run_at` text,
	`lease_until` text,
	`last_run_at` text,
	`last_status` text,
	`last_duration_ms` integer,
	`fail_count` integer DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE `logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` text,
	`level` text,
	`source` text,
	`message` text
);
--> statement-breakpoint
CREATE TABLE `meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text
);
--> statement-breakpoint
CREATE TABLE `notify_state` (
	`policy` text PRIMARY KEY NOT NULL,
	`state_json` text,
	`version` integer
);
--> statement-breakpoint
CREATE TABLE `pair_codes` (
	`code_hash` text PRIMARY KEY NOT NULL,
	`expires_at` text,
	`used_at` text,
	`created_by` text
);
--> statement-breakpoint
CREATE TABLE `push_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` text,
	`policy` text,
	`title` text,
	`body` text,
	`device_count` integer,
	`result` text
);
--> statement-breakpoint
CREATE TABLE `rate_buckets` (
	`name` text PRIMARY KEY NOT NULL,
	`tokens` real,
	`updated_at` text
);
--> statement-breakpoint
CREATE TABLE `secrets` (
	`name` text PRIMARY KEY NOT NULL,
	`ciphertext` text,
	`iv` text,
	`hint` text,
	`last_test_json` text,
	`updated_at` text
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`json` text,
	`revision` integer,
	`updated_at` text,
	`updated_by` text,
	CONSTRAINT "settings_id_check" CHECK("settings"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE `snapshots` (
	`source` text PRIMARY KEY NOT NULL,
	`json` text,
	`state` text,
	`fetched_at` text,
	`observed_at` text,
	`error_json` text,
	`etag` text,
	`last_modified` text,
	`config_key` text
);

--> statement-breakpoint
-- 初始 settings 行：DEFAULT_SETTINGS 的 JSON 序列化，revision 从 1 开始（见 CONTRACT.md 第 3 节 settings 乐观锁）。
INSERT INTO `settings` (`id`, `json`, `revision`, `updated_at`, `updated_by`) VALUES (
	1,
	'{"originAddress":"","destinationAddress":"","originStation":"","destStation":"","workWindowStart":"07:00","workWindowEnd":"10:00","returnWindowStart":"14:00","returnWindowEnd":"16:00","notifyCommuteDisruption":false,"notifyFootballMatch":false,"notifyMorningBrief":false,"transitPassUntil":"","parkingPassUntil":"","notifyTicketExpiry":false,"watchedLineId":"","watchedLineCode":"","watchedStopAId":"","watchedStopAName":"","watchedStopBId":"","watchedStopBName":""}',
	1,
	strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
	NULL
);
