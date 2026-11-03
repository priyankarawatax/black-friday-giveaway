export function normalizeShopDomain(value) {
  const trimmed = String(value ?? "").trim().toLowerCase();
  if (!trimmed) return "";

  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    return url.hostname;
  } catch {
    return trimmed.replace(/^https?:\/\//, "").split("/")[0];
  }
}

export function isMyShopifyDomain(value) {
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(
    normalizeShopDomain(value),
  );
}
