CREATE TABLE `GiveawayEntry` (
  `id` VARCHAR(191) NOT NULL,
  `shop` VARCHAR(191) NOT NULL,
  `campaignId` VARCHAR(191) NOT NULL,
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

  UNIQUE INDEX `GiveawayEntry_shop_shopifyOrderId_key`(`shop`, `shopifyOrderId`),
  INDEX `GiveawayEntry_shop_campaignId_status_orderDate_idx`(`shop`, `campaignId`, `status`, `orderDate`),
  INDEX `GiveawayEntry_shop_shopifyCustomerId_idx`(`shop`, `shopifyCustomerId`),
  INDEX `GiveawayEntry_shop_customerEmail_idx`(`shop`, `customerEmail`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `GiveawayTicket` (
  `id` VARCHAR(191) NOT NULL,
  `shop` VARCHAR(191) NOT NULL,
  `campaignId` VARCHAR(191) NOT NULL,
  `entryId` VARCHAR(191) NOT NULL,
  `ticketNumber` VARCHAR(191) NOT NULL,
  `status` VARCHAR(32) NOT NULL DEFAULT 'VALID',
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `GiveawayTicket_campaignId_ticketNumber_key`(`campaignId`, `ticketNumber`),
  INDEX `GiveawayTicket_shop_campaignId_status_idx`(`shop`, `campaignId`, `status`),
  INDEX `GiveawayTicket_shop_ticketNumber_idx`(`shop`, `ticketNumber`),
  INDEX `GiveawayTicket_entryId_status_idx`(`entryId`, `status`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `GiveawayEntry`
  ADD CONSTRAINT `GiveawayEntry_campaignId_fkey`
  FOREIGN KEY (`campaignId`) REFERENCES `CampaignSettings`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `GiveawayTicket`
  ADD CONSTRAINT `GiveawayTicket_entryId_fkey`
  FOREIGN KEY (`entryId`) REFERENCES `GiveawayEntry`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;
