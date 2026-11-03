import prisma from "../db.server";
import {
  decryptKlaviyoApiKey,
  normalizeShopDomain,
  selectLegacyKlaviyoApiKey,
} from "./klaviyo-secrets.server.js";

export {
  decryptKlaviyoApiKey,
  encryptKlaviyoApiKey,
  isMyShopifyDomain,
  maskKlaviyoApiKey,
  normalizeShopDomain,
  selectLegacyKlaviyoApiKey,
} from "./klaviyo-secrets.server.js";

export const DEFAULT_KLAVIYO_EVENT_NAME = "Giveaway Tickets Confirmed";
export const DEFAULT_KLAVIYO_REVISION = "2026-04-15";

const KLAVIYO_ACCOUNTS_ENDPOINT = "https://a.klaviyo.com/api/accounts";

export type KlaviyoConfigSource = "database" | "legacy-environment" | "none";

export type ResolvedKlaviyoConfig = {
  shop: string;
  enabled: boolean;
  configured: boolean;
  eventName: string;
  source: KlaviyoConfigSource;
  apiKey?: string;
  error?: string;
};

export function getLegacyKlaviyoApiKeyForShop(shop: string) {
  return selectLegacyKlaviyoApiKey(
    shop,
    process.env.KLAVIYO_LEGACY_SHOP_DOMAIN ?? "",
    process.env.KLAVIYO_PRIVATE_API_KEY ?? "",
  );
}

export async function getKlaviyoQueueConfig(shop: string) {
  const normalizedShop = normalizeShopDomain(shop);
  const stored = await prisma.klaviyoStoreConfig.findUnique({
    where: { shop: normalizedShop },
    select: { enabled: true, eventName: true },
  });

  if (stored) {
    return {
      enabled: stored.enabled,
      eventName: stored.eventName.trim() || DEFAULT_KLAVIYO_EVENT_NAME,
    };
  }

  return {
    enabled: Boolean(getLegacyKlaviyoApiKeyForShop(normalizedShop)),
    eventName:
      process.env.KLAVIYO_EVENT_NAME?.trim() || DEFAULT_KLAVIYO_EVENT_NAME,
  };
}

export async function resolveKlaviyoConfig(
  shop: string,
): Promise<ResolvedKlaviyoConfig> {
  const normalizedShop = normalizeShopDomain(shop);
  const stored = await prisma.klaviyoStoreConfig.findUnique({
    where: { shop: normalizedShop },
  });
  const legacyApiKey = getLegacyKlaviyoApiKeyForShop(normalizedShop);

  if (!stored) {
    return legacyApiKey
      ? {
          shop: normalizedShop,
          enabled: true,
          configured: true,
          eventName:
            process.env.KLAVIYO_EVENT_NAME?.trim() ||
            DEFAULT_KLAVIYO_EVENT_NAME,
          source: "legacy-environment",
          apiKey: legacyApiKey,
        }
      : {
          shop: normalizedShop,
          enabled: false,
          configured: false,
          eventName: DEFAULT_KLAVIYO_EVENT_NAME,
          source: "none",
        };
  }

  const eventName = stored.eventName.trim() || DEFAULT_KLAVIYO_EVENT_NAME;
  if (!stored.enabled) {
    return {
      shop: normalizedShop,
      enabled: false,
      configured: false,
      eventName,
      source: "database",
    };
  }

  if (stored.privateApiKeyEncrypted) {
    try {
      return {
        shop: normalizedShop,
        enabled: true,
        configured: true,
        eventName,
        source: "database",
        apiKey: decryptKlaviyoApiKey(stored.privateApiKeyEncrypted),
      };
    } catch (error) {
      return {
        shop: normalizedShop,
        enabled: true,
        configured: false,
        eventName,
        source: "database",
        error: error instanceof Error ? error.message : "Credential decryption failed.",
      };
    }
  }

  if (legacyApiKey) {
    return {
      shop: normalizedShop,
      enabled: true,
      configured: true,
      eventName,
      source: "legacy-environment",
      apiKey: legacyApiKey,
    };
  }

  return {
    shop: normalizedShop,
    enabled: true,
    configured: false,
    eventName,
    source: "database",
    error: `Klaviyo credentials are missing for ${normalizedShop}.`,
  };
}

export async function validateKlaviyoCredentials(apiKey: string) {
  const response = await fetch(KLAVIYO_ACCOUNTS_ENDPOINT, {
    method: "GET",
    headers: {
      Accept: "application/vnd.api+json",
      Authorization: `Klaviyo-API-Key ${apiKey.trim()}`,
      Revision:
        process.env.KLAVIYO_API_REVISION?.trim() || DEFAULT_KLAVIYO_REVISION,
    },
    signal: AbortSignal.timeout(8_000),
  });

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        "Klaviyo rejected the key. Confirm that it is valid and includes accounts:read and events:write scopes.",
      );
    }
    throw new Error(`Klaviyo connection test failed with status ${response.status}.`);
  }

  const body = (await response.json()) as {
    data?: Array<{ id?: string; attributes?: { contact_information?: unknown } }>;
  };
  const accountId = body.data?.[0]?.id?.trim();
  if (!accountId) throw new Error("Klaviyo returned no accessible account.");

  return { accountId };
}
