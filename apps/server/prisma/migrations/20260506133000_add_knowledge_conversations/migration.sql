CREATE TABLE `knowledge_conversations` (
    `id` VARCHAR(36) NOT NULL,
    `user_id` VARCHAR(36) NOT NULL,
    `title` VARCHAR(255) NOT NULL,
    `categories` TEXT NOT NULL,
    `use_knowledge_base` BOOLEAN NOT NULL DEFAULT true,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `knowledge_conversations_user_id_idx`(`user_id`),
    INDEX `knowledge_conversations_updated_at_idx`(`updated_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `knowledge_messages` (
    `id` VARCHAR(36) NOT NULL,
    `conversation_id` VARCHAR(36) NOT NULL,
    `role` VARCHAR(32) NOT NULL,
    `content` TEXT NOT NULL,
    `sources` TEXT NOT NULL,
    `sequence` INTEGER NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `knowledge_messages_conversation_id_idx`(`conversation_id`),
    INDEX `knowledge_messages_sequence_idx`(`sequence`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `knowledge_conversations` ADD CONSTRAINT `knowledge_conversations_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `knowledge_messages` ADD CONSTRAINT `knowledge_messages_conversation_id_fkey` FOREIGN KEY (`conversation_id`) REFERENCES `knowledge_conversations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
