ALTER TABLE `CampaignSettings`
  ADD COLUMN `englishTicketMessage` TEXT NULL,
  ADD COLUMN `frenchTicketMessage` TEXT NULL,
  ADD COLUMN `englishMotivationMessage` TEXT NULL,
  ADD COLUMN `frenchMotivationMessage` TEXT NULL;

UPDATE `CampaignSettings`
SET
  `englishTicketMessage` = 'This order earns you {ticket} tickets. Your total will be {ticket} tickets.',
  `frenchTicketMessage` = 'Cette commande vous rapporte {ticket} billets. Votre total sera de {ticket} billets.',
  `englishMotivationMessage` = 'The more tickets you have, the higher your chances to win a trip to Asia.',
  `frenchMotivationMessage` = 'Plus vous avez de billets, plus vous avez de chances de gagner un voyage en Asie.',
  `englishMessage` = CASE
    WHEN `englishMessage` = 'You''re entering our Black Friday Giveaway. Complete your checkout to confirm your entry. Terms and conditions apply.'
      THEN 'You''re entered in our Black Friday Giveaway!'
    ELSE `englishMessage`
  END,
  `frenchMessage` = CASE
    WHEN `frenchMessage` = 'Vous participez à notre concours du Vendredi fou. Finalisez votre paiement pour confirmer votre participation. Des conditions s''appliquent.'
      THEN 'Vous participez à notre concours du Vendredi fou !'
    ELSE `frenchMessage`
  END;

ALTER TABLE `CampaignSettings`
  MODIFY `englishTicketMessage` TEXT NOT NULL,
  MODIFY `frenchTicketMessage` TEXT NOT NULL,
  MODIFY `englishMotivationMessage` TEXT NOT NULL,
  MODIFY `frenchMotivationMessage` TEXT NOT NULL;
