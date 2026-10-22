ALTER TABLE `GiveawayTicket`
  ADD CONSTRAINT `GiveawayTicket_campaignId_fkey`
  FOREIGN KEY (`campaignId`) REFERENCES `CampaignSettings`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;
