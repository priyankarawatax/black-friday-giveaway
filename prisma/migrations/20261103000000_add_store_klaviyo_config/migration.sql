CREATE TABLE `KlaviyoStoreConfig` (
  `shop` VARCHAR(191) NOT NULL,
  `enabled` BOOLEAN NOT NULL DEFAULT false,
  `privateApiKeyEncrypted` TEXT NULL,
  `privateApiKeyLastFour` VARCHAR(8) NULL,
  `accountId` VARCHAR(191) NULL,
  `eventName` VARCHAR(191) NOT NULL DEFAULT 'Giveaway Tickets Confirmed',
  `connectionStatus` VARCHAR(32) NOT NULL DEFAULT 'NOT_CONFIGURED',
  `lastValidatedAt` DATETIME(3) NULL,
  `lastError` TEXT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  INDEX `KlaviyoStoreConfig_enabled_connectionStatus_idx`(`enabled`, `connectionStatus`),
  PRIMARY KEY (`shop`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
