SET FOREIGN_KEY_CHECKS = 0;

CREATE TABLE `CampaignSettings_bigint` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `shop` VARCHAR(191) NOT NULL,
  `campaignName` VARCHAR(255) NOT NULL,
  `startDate` DATETIME(3) NULL,
  `endDate` DATETIME(3) NULL,
  `timezone` VARCHAR(191) NOT NULL,
  `enabled` BOOLEAN NOT NULL DEFAULT false,
  `englishMessage` TEXT NOT NULL,
  `frenchMessage` TEXT NOT NULL,
  `englishThankYouMessage` TEXT NOT NULL,
  `frenchThankYouMessage` TEXT NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `CampaignSettings_shop_key` (`shop`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT INTO `CampaignSettings_bigint` (
  `shop`, `campaignName`, `startDate`, `endDate`, `timezone`, `enabled`,
  `englishMessage`, `frenchMessage`, `englishThankYouMessage`,
  `frenchThankYouMessage`, `createdAt`, `updatedAt`
)
SELECT
  `shop`, `campaignName`, `startDate`, `endDate`, `timezone`, `enabled`,
  `englishMessage`, `frenchMessage`, `englishThankYouMessage`,
  `frenchThankYouMessage`, `createdAt`, `updatedAt`
FROM `CampaignSettings`
ORDER BY `createdAt`, `shop`;

CREATE TABLE `GiveawayEntry_bigint` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `shop` VARCHAR(191) NOT NULL,
  `campaignId` BIGINT UNSIGNED NOT NULL,
  `shopifyCustomerId` VARCHAR(191) NOT NULL,
  `customerName` VARCHAR(255) NOT NULL,
  `customerEmail` VARCHAR(320) NOT NULL,
  `shopifyOrderId` VARCHAR(191) NOT NULL,
  `orderNumber` VARCHAR(191) NOT NULL,
  `orderDate` DATETIME(3) NOT NULL,
  `eligibleAmount` DECIMAL(18, 2) NOT NULL,
  `currencyCode` VARCHAR(3) NOT NULL,
  `source` VARCHAR(64) NOT NULL DEFAULT 'SHOPIFY_ORDER',
  `status` VARCHAR(32) NOT NULL DEFAULT 'ELIGIBLE',
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `GiveawayEntry_shop_shopifyOrderId_key` (`shop`, `shopifyOrderId`),
  INDEX `GiveawayEntry_shop_campaignId_status_orderDate_idx` (`shop`, `campaignId`, `status`, `orderDate`),
  INDEX `GiveawayEntry_shop_shopifyCustomerId_idx` (`shop`, `shopifyCustomerId`),
  INDEX `GiveawayEntry_shop_customerEmail_idx` (`shop`, `customerEmail`),
  PRIMARY KEY (`id`),
  CONSTRAINT `GiveawayEntry_bigint_campaignId_fkey` FOREIGN KEY (`campaignId`) REFERENCES `CampaignSettings_bigint` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT INTO `GiveawayEntry_bigint` (
  `shop`, `campaignId`, `shopifyCustomerId`, `customerName`, `customerEmail`,
  `shopifyOrderId`, `orderNumber`, `orderDate`, `eligibleAmount`, `currencyCode`,
  `source`, `status`, `createdAt`, `updatedAt`
)
SELECT
  e.`shop`, c_new.`id`, e.`shopifyCustomerId`, e.`customerName`, e.`customerEmail`,
  e.`shopifyOrderId`, e.`orderNumber`, e.`orderDate`, e.`eligibleAmount`, e.`currencyCode`,
  e.`source`, e.`status`, e.`createdAt`, e.`updatedAt`
FROM `GiveawayEntry` e
JOIN `CampaignSettings` c_old ON c_old.`id` = e.`campaignId`
JOIN `CampaignSettings_bigint` c_new ON c_new.`shop` = c_old.`shop`
ORDER BY e.`createdAt`, e.`shopifyOrderId`;

CREATE TABLE `GiveawayTicket_bigint` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `shop` VARCHAR(191) NOT NULL,
  `campaignId` BIGINT UNSIGNED NOT NULL,
  `entryId` BIGINT UNSIGNED NOT NULL,
  `ticketNumber` VARCHAR(191) NOT NULL,
  `status` VARCHAR(32) NOT NULL DEFAULT 'VALID',
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `GiveawayTicket_campaignId_ticketNumber_key` (`campaignId`, `ticketNumber`),
  INDEX `GiveawayTicket_shop_campaignId_status_idx` (`shop`, `campaignId`, `status`),
  INDEX `GiveawayTicket_shop_ticketNumber_idx` (`shop`, `ticketNumber`),
  INDEX `GiveawayTicket_entryId_status_idx` (`entryId`, `status`),
  PRIMARY KEY (`id`),
  CONSTRAINT `GiveawayTicket_bigint_campaignId_fkey` FOREIGN KEY (`campaignId`) REFERENCES `CampaignSettings_bigint` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `GiveawayTicket_bigint_entryId_fkey` FOREIGN KEY (`entryId`) REFERENCES `GiveawayEntry_bigint` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT INTO `GiveawayTicket_bigint` (
  `shop`, `campaignId`, `entryId`, `ticketNumber`, `status`, `createdAt`
)
SELECT
  t.`shop`, c_new.`id`, e_new.`id`, t.`ticketNumber`, t.`status`, t.`createdAt`
FROM `GiveawayTicket` t
JOIN `CampaignSettings` c_old ON c_old.`id` = t.`campaignId`
JOIN `CampaignSettings_bigint` c_new ON c_new.`shop` = c_old.`shop`
JOIN `GiveawayEntry` e_old ON e_old.`id` = t.`entryId`
JOIN `GiveawayEntry_bigint` e_new
  ON e_new.`shop` = e_old.`shop`
  AND e_new.`shopifyOrderId` = e_old.`shopifyOrderId`
ORDER BY t.`createdAt`, t.`ticketNumber`;

DROP TABLE `GiveawayTicket`;
DROP TABLE `GiveawayEntry`;
DROP TABLE `CampaignSettings`;

RENAME TABLE `CampaignSettings_bigint` TO `CampaignSettings`;
RENAME TABLE `GiveawayEntry_bigint` TO `GiveawayEntry`;
RENAME TABLE `GiveawayTicket_bigint` TO `GiveawayTicket`;

SET FOREIGN_KEY_CHECKS = 1;
