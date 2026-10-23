CREATE TABLE `KlaviyoEventOutbox` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `shop` VARCHAR(191) NOT NULL,
  `campaignId` BIGINT UNSIGNED NOT NULL,
  `entryId` BIGINT UNSIGNED NOT NULL,
  `uniqueId` VARCHAR(512) NOT NULL,
  `metricName` VARCHAR(191) NOT NULL,
  `payload` JSON NOT NULL,
  `status` VARCHAR(32) NOT NULL DEFAULT 'PENDING',
  `attempts` INTEGER UNSIGNED NOT NULL DEFAULT 0,
  `nextAttemptAt` DATETIME(3) NULL,
  `sentAt` DATETIME(3) NULL,
  `lastError` TEXT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `KlaviyoEventOutbox_uniqueId_key`(`uniqueId`),
  UNIQUE INDEX `KlaviyoEventOutbox_shop_entryId_key`(`shop`, `entryId`),
  INDEX `KlaviyoEventOutbox_status_nextAttemptAt_idx`(`status`, `nextAttemptAt`),
  INDEX `KlaviyoEventOutbox_shop_campaignId_status_idx`(`shop`, `campaignId`, `status`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `KlaviyoEventOutbox`
  ADD CONSTRAINT `KlaviyoEventOutbox_campaignId_fkey`
  FOREIGN KEY (`campaignId`) REFERENCES `CampaignSettings`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `KlaviyoEventOutbox`
  ADD CONSTRAINT `KlaviyoEventOutbox_entryId_fkey`
  FOREIGN KEY (`entryId`) REFERENCES `GiveawayEntry`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;
