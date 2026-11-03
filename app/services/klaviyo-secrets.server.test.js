import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";

import {
  decryptKlaviyoApiKey,
  encryptKlaviyoApiKey,
  isMyShopifyDomain,
  maskKlaviyoApiKey,
  normalizeShopDomain,
  selectLegacyKlaviyoApiKey,
} from "./klaviyo-secrets.server.js";

const KEY_ONE = Buffer.alloc(32, 1).toString("base64");
const KEY_TWO = Buffer.alloc(32, 2).toString("base64");

test("normalizes authenticated Shopify shop domains", () => {
  assert.equal(
    normalizeShopDomain("benoit-vintage.myshopify.com"),
    "benoit-vintage.myshopify.com",
  );
  assert.equal(
    normalizeShopDomain("HTTPS://United-Vintage-UK.myshopify.com/admin"),
    "united-vintage-uk.myshopify.com",
  );
  assert.equal(isMyShopifyDomain("united-vintage-uk.myshopify.com"), true);
  assert.equal(isMyShopifyDomain("united-vintage.uk"), false);
});

test("encrypts and decrypts a Klaviyo private key", () => {
  const encrypted = encryptKlaviyoApiKey("pk_private_value_1234", KEY_ONE);
  assert.notEqual(encrypted, "pk_private_value_1234");
  assert.equal(
    decryptKlaviyoApiKey(encrypted, KEY_ONE),
    "pk_private_value_1234",
  );
  assert.equal(maskKlaviyoApiKey("pk_private_value_1234"), "••••••••1234");
});

test("does not decrypt one store credential with another encryption key", () => {
  const encrypted = encryptKlaviyoApiKey("pk_private_value_1234", KEY_ONE);
  assert.throws(
    () => decryptKlaviyoApiKey(encrypted, KEY_TWO),
    /could not be decrypted/,
  );
});

test("rejects invalid encryption keys", () => {
  assert.throws(
    () => encryptKlaviyoApiKey("pk_private_value_1234", "too-short"),
    /must be a 32-byte key/,
  );
});

test("legacy credentials are only selected for the explicitly configured shop", () => {
  const key = "pk_united_vintage";
  assert.equal(
    selectLegacyKlaviyoApiKey(
      "benoit-vintage.myshopify.com",
      "benoit-vintage.myshopify.com",
      key,
    ),
    key,
  );
  assert.equal(
    selectLegacyKlaviyoApiKey(
      "united-vintage-uk.myshopify.com",
      "benoit-vintage.myshopify.com",
      key,
    ),
    null,
  );
});
