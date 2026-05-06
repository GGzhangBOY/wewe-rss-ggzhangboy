CREATE TABLE `account_users` (
    `user_id` VARCHAR(36) NOT NULL,
    `account_id` VARCHAR(255) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `account_users_account_id_idx`(`account_id`),
    PRIMARY KEY (`user_id`, `account_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT IGNORE INTO `account_users` (`user_id`, `account_id`, `created_at`, `updated_at`)
SELECT `user_id`, `id`, NOW(3), NOW(3)
FROM `accounts`
WHERE `user_id` IS NOT NULL;

UPDATE `accounts`
SET `user_id` = NULL
WHERE `user_id` IS NOT NULL;

ALTER TABLE `account_users` ADD CONSTRAINT `account_users_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `account_users` ADD CONSTRAINT `account_users_account_id_fkey` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
