ALTER TABLE `accounts` ADD COLUMN `user_id` VARCHAR(36) NULL;
CREATE INDEX `accounts_user_id_idx` ON `accounts`(`user_id`);

CREATE TABLE `user_feeds` (
    `user_id` VARCHAR(36) NOT NULL,
    `feed_id` VARCHAR(255) NOT NULL,
    `status` INTEGER NOT NULL DEFAULT 1,
    `category` VARCHAR(255) NOT NULL DEFAULT '',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `user_feeds_feed_id_idx`(`feed_id`),
    PRIMARY KEY (`user_id`, `feed_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

UPDATE `accounts`
SET `user_id` = (SELECT `id` FROM `users` WHERE `username` = 'admin' LIMIT 1)
WHERE `user_id` IS NULL;

INSERT IGNORE INTO `user_feeds` (`user_id`, `feed_id`, `status`, `category`, `created_at`, `updated_at`)
SELECT `users`.`id`, `feeds`.`id`, `feeds`.`status`, `feeds`.`category`, NOW(3), NOW(3)
FROM `users`
JOIN `feeds`
WHERE `users`.`username` = 'admin';

ALTER TABLE `accounts` ADD CONSTRAINT `accounts_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `user_feeds` ADD CONSTRAINT `user_feeds_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `user_feeds` ADD CONSTRAINT `user_feeds_feed_id_fkey` FOREIGN KEY (`feed_id`) REFERENCES `feeds`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
