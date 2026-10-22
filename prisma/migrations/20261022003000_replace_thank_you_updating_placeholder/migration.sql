UPDATE `CampaignSettings`
SET `englishThankYouMessage` = REPLACE(
  `englishThankYouMessage`,
  '🎟️ Your Tickets: Updating shortly',
  '🎟️ Your Tickets: {tickets}.'
)
WHERE `englishThankYouMessage` LIKE '%Your Tickets: Updating shortly%';

UPDATE `CampaignSettings`
SET `frenchThankYouMessage` = REPLACE(
  `frenchThankYouMessage`,
  '🎟️ Vos billets : mise à jour prochaine',
  '🎟️ Vos billets : {tickets}.'
)
WHERE `frenchThankYouMessage` LIKE '%Vos billets : mise à jour prochaine%';
