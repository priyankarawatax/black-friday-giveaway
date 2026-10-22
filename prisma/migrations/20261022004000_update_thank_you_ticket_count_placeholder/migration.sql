UPDATE `CampaignSettings`
SET `englishThankYouMessage` = REPLACE(
  REPLACE(`englishThankYouMessage`, '🎟️ Your Tickets: {tickets}.', 'You earn total {tickets-num} tickets.'),
  'Your Tickets: {tickets}.',
  'You earn total {tickets-num} tickets.'
)
WHERE `englishThankYouMessage` LIKE '%{tickets}%';

UPDATE `CampaignSettings`
SET `frenchThankYouMessage` = REPLACE(
  REPLACE(`frenchThankYouMessage`, '🎟️ Vos billets : {tickets}.', 'Vous gagnez un total de {tickets-num} billets.'),
  'Vos billets : {tickets}.',
  'Vous gagnez un total de {tickets-num} billets.'
)
WHERE `frenchThankYouMessage` LIKE '%{tickets}%';
