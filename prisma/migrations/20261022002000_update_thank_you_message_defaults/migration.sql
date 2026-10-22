UPDATE `CampaignSettings`
SET `englishThankYouMessage` = 'You''re In! Black Friday Giveaway\n\nThank you for your order!\n🎟️ Your Tickets: {tickets}.\nMore tickets, more chances to win a dream trip to Asia!'
WHERE `englishThankYouMessage` = 'Thank you for your order! Your entry into our Black Friday Giveaway has been confirmed. Good luck!';

UPDATE `CampaignSettings`
SET `frenchThankYouMessage` = 'Vous participez au concours du Vendredi fou !\n\nMerci pour votre commande !\n🎟️ Vos billets : {tickets}.\nPlus de billets, plus de chances de gagner un voyage de rêve en Asie !'
WHERE `frenchThankYouMessage` = 'Merci pour votre commande ! Votre participation à notre concours du Vendredi fou est confirmée. Bonne chance !';
