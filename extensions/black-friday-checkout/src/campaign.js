export function parseCampaignConfig(value) {
  if (typeof value !== "string" || !value.trim()) return null;

  try {
    const config = JSON.parse(value);
    return config && typeof config === "object" ? config : null;
  } catch {
    return null;
  }
}

export function isCampaignActive(config, now = Date.now()) {
  if (!config?.enabled || !config.startAt || !config.endAt) return false;

  const start = Date.parse(config.startAt);
  const end = Date.parse(config.endAt);
  return (
    Number.isFinite(start) && Number.isFinite(end) && now >= start && now <= end
  );
}

export function getCheckoutMessage(config, languageCode) {
  return getCheckoutMessages(config, languageCode).entry;
}

export function isFrenchLanguage(languageCode) {
  return String(languageCode ?? "").toLowerCase().split("-")[0] === "fr";
}

function normalizeMessageSet(value) {
  if (typeof value === "string") {
    return { entry: value.trim(), tickets: "", motivation: "" };
  }
  return {
    entry: value?.entry?.trim?.() ?? "",
    tickets: value?.tickets?.trim?.() ?? "",
    motivation: value?.motivation?.trim?.() ?? "",
  };
}

export function getCheckoutMessages(config, languageCode) {
  const english = normalizeMessageSet(config?.messages?.en);
  const french = normalizeMessageSet(config?.messages?.fr);
  if (!isFrenchLanguage(languageCode)) return english;
  return {
    entry: french.entry || english.entry,
    tickets: french.tickets || english.tickets,
    motivation: french.motivation || english.motivation,
  };
}

export function renderTicketMessage(template, orderTickets, totalTickets) {
  const message = String(template ?? "")
    .replaceAll("{tickets}", String(orderTickets))
    .replaceAll("{total-tickets}", String(totalTickets));

  // Keep previously saved templates working until the merchant saves again.
  let occurrence = 0;
  return message.replace(/\{ticket\}/g, () => {
    occurrence += 1;
    return String(occurrence === 1 ? orderTickets : totalTickets);
  });
}

export function renderThankYouMessage(template, totalTickets) {
  return String(template ?? "")
    .replaceAll("{tickets-num}", String(totalTickets))
    .replaceAll("{tickets}", String(totalTickets));
}

export function getTicketCountFromTotal(amount) {
  const numericAmount = Number(amount);
  return Number.isFinite(numericAmount) && numericAmount > 0
    ? Math.floor(numericAmount)
    : 0;
}

export function getTicketSummary(orderTickets, previousTickets) {
  const current = Math.max(0, Math.floor(Number(orderTickets) || 0));
  const previous = Math.max(0, Math.floor(Number(previousTickets) || 0));
  return { orderTickets: current, totalTickets: previous + current };
}
