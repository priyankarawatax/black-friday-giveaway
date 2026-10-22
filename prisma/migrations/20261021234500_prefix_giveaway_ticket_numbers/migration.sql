UPDATE `GiveawayTicket`
SET `ticketNumber` = CONCAT(
  'UVT-',
  LPAD(CAST(CAST(`ticketNumber` AS UNSIGNED) AS CHAR), 3, '0')
)
WHERE `ticketNumber` REGEXP '^[0-9]+$';
