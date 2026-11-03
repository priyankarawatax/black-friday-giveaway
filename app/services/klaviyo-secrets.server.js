import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { normalizeShopDomain } from "./shop-domain.js";

export { isMyShopifyDomain, normalizeShopDomain } from "./shop-domain.js";

const ENCRYPTION_AAD = Buffer.from("klaviyo-private-api-key:v1");

function parseEncryptionKey(value = process.env.KLAVIYO_ENCRYPTION_KEY ?? "") {
  const trimmed = value.trim();
  const key = /^[a-f0-9]{64}$/i.test(trimmed)
    ? Buffer.from(trimmed, "hex")
    : Buffer.from(trimmed, "base64");

  if (key.length !== 32) {
    throw new Error(
      "KLAVIYO_ENCRYPTION_KEY must be a 32-byte key encoded as base64 or 64 hexadecimal characters.",
    );
  }
  return key;
}

export function encryptKlaviyoApiKey(
  apiKey,
  encryptionKey = process.env.KLAVIYO_ENCRYPTION_KEY ?? "",
) {
  const normalized = apiKey.trim();
  if (!normalized) throw new Error("A Klaviyo private API key is required.");

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", parseEncryptionKey(encryptionKey), iv);
  cipher.setAAD(ENCRYPTION_AAD);
  const encrypted = Buffer.concat([
    cipher.update(normalized, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return ["v1", iv, tag, encrypted]
    .map((part) => (typeof part === "string" ? part : part.toString("base64url")))
    .join(".");
}

export function decryptKlaviyoApiKey(
  encryptedValue,
  encryptionKey = process.env.KLAVIYO_ENCRYPTION_KEY ?? "",
) {
  const [version, ivValue, tagValue, encrypted] = encryptedValue.split(".");
  if (version !== "v1" || !ivValue || !tagValue || !encrypted) {
    throw new Error("The stored Klaviyo credential has an unsupported format.");
  }

  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      parseEncryptionKey(encryptionKey),
      Buffer.from(ivValue, "base64url"),
    );
    decipher.setAAD(ENCRYPTION_AAD);
    decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(encrypted, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("KLAVIYO_ENCRYPTION_KEY")
    ) {
      throw error;
    }
    throw new Error("The stored Klaviyo credential could not be decrypted.");
  }
}

export function maskKlaviyoApiKey(apiKey) {
  const normalized = apiKey.trim();
  return normalized ? `••••••••${normalized.slice(-4)}` : "Not configured";
}

export function selectLegacyKlaviyoApiKey(shop, legacyShop, apiKey) {
  const normalizedShop = normalizeShopDomain(shop);
  const normalizedLegacyShop = normalizeShopDomain(legacyShop);
  if (!normalizedLegacyShop || normalizedLegacyShop !== normalizedShop) return null;
  return String(apiKey ?? "").trim() || null;
}
