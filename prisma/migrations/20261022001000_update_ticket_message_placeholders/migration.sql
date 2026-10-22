UPDATE `CampaignSettings`
SET
  `englishTicketMessage` = 'This order earns you {tickets} tickets. Your total will be {total-tickets} tickets.'
WHERE `englishTicketMessage` = 'This order earns you {ticket} tickets. Your total will be {ticket} tickets.';

UPDATE `CampaignSettings`
SET
  `frenchTicketMessage` = 'Cette commande vous rapporte {tickets} billets. Votre total sera de {total-tickets} billets.'
WHERE `frenchTicketMessage` = 'Cette commande vous rapporte {ticket} billets. Votre total sera de {ticket} billets.';
