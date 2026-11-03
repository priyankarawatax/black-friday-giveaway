import { useEffect, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData, useRouteError } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";

import prisma from "../db.server";
import {
  decryptKlaviyoApiKey,
  encryptKlaviyoApiKey,
  getLegacyKlaviyoApiKeyForShop,
  maskKlaviyoApiKey,
  normalizeShopDomain,
  resolveKlaviyoConfig,
  validateKlaviyoCredentials,
} from "../services/klaviyo-config.server";
import { authenticate } from "../shopify.server";

type ActionData =
  | { ok: true; message: string; accountId?: string }
  | { ok: false; error: string };

function safeError(error: unknown) {
  return error instanceof Error ? error.message : "The request could not be completed.";
}

async function getSettings(shop: string) {
  const normalizedShop = normalizeShopDomain(shop);
  const [stored, resolved] = await Promise.all([
    prisma.klaviyoStoreConfig.findUnique({ where: { shop: normalizedShop } }),
    resolveKlaviyoConfig(normalizedShop),
  ]);

  const maskedKey = stored?.privateApiKeyLastFour
    ? `••••••••${stored.privateApiKeyLastFour}`
    : resolved.apiKey
      ? maskKlaviyoApiKey(resolved.apiKey)
      : "Not configured";

  return {
    shop: normalizedShop,
    enabled: stored?.enabled ?? resolved.enabled,
    eventName: stored?.eventName ?? resolved.eventName,
    maskedKey,
    hasCredential: resolved.configured,
    source: resolved.source,
    accountId: stored?.accountId ?? null,
    connectionStatus:
      stored?.connectionStatus ??
      (resolved.configured ? "LEGACY_ENVIRONMENT" : "NOT_CONFIGURED"),
    lastValidatedAt: stored?.lastValidatedAt?.toISOString() ?? null,
    lastError: stored?.lastError ?? resolved.error ?? null,
  };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  return getSettings(session.shop);
};

export const action = async ({ request }: ActionFunctionArgs): Promise<ActionData> => {
  const { session } = await authenticate.admin(request);
  const shop = normalizeShopDomain(session.shop);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "save");
  const submittedApiKey = String(formData.get("privateApiKey") ?? "").trim();

  if (intent === "test") {
    try {
      let apiKey = submittedApiKey;
      if (!apiKey) {
        const stored = await prisma.klaviyoStoreConfig.findUnique({
          where: { shop },
        });
        if (stored?.privateApiKeyEncrypted) {
          apiKey = decryptKlaviyoApiKey(stored.privateApiKeyEncrypted);
        } else {
          const resolved = await resolveKlaviyoConfig(shop);
          apiKey =
            resolved.apiKey ?? getLegacyKlaviyoApiKeyForShop(shop) ?? "";
        }
      }
      if (!apiKey) {
        return { ok: false, error: `Klaviyo credentials are missing for ${shop}.` };
      }

      const result = await validateKlaviyoCredentials(apiKey);
      if (!submittedApiKey) {
        await prisma.klaviyoStoreConfig.updateMany({
          where: { shop },
          data: {
            accountId: result.accountId,
            connectionStatus: "CONNECTED",
            lastValidatedAt: new Date(),
            lastError: null,
          },
        });
      }
      return {
        ok: true,
        message: submittedApiKey
          ? "Connection successful. Save the settings to store this key."
          : "Connection successful.",
        accountId: result.accountId,
      };
    } catch (error) {
      const message = safeError(error);
      if (!submittedApiKey) {
        await prisma.klaviyoStoreConfig.updateMany({
          where: { shop },
          data: {
            connectionStatus: "ERROR",
            lastValidatedAt: new Date(),
            lastError: message.slice(0, 2_000),
          },
        });
      }
      return { ok: false, error: message };
    }
  }

  const enabled = formData.get("enabled") === "true";
  const eventName = String(formData.get("eventName") ?? "").trim();
  if (!eventName || eventName.length > 191) {
    return {
      ok: false,
      error: "Enter a Klaviyo event name between 1 and 191 characters.",
    };
  }

  const existing = await prisma.klaviyoStoreConfig.findUnique({ where: { shop } });
  let encryptedKey = existing?.privateApiKeyEncrypted ?? null;
  let keyLastFour = existing?.privateApiKeyLastFour ?? null;
  let connectionStatus = enabled
    ? existing?.connectionStatus ?? "NOT_CONFIGURED"
    : "DISABLED";

  try {
    if (submittedApiKey) {
      encryptedKey = encryptKlaviyoApiKey(submittedApiKey);
      keyLastFour = submittedApiKey.slice(-4);
      connectionStatus = "UNTESTED";
    }

    if (enabled && !encryptedKey) {
      if (!getLegacyKlaviyoApiKeyForShop(shop)) {
        return {
          ok: false,
          error: `Klaviyo credentials are missing for ${shop}. Enter a private API key before enabling the integration.`,
        };
      }
    }

    await prisma.klaviyoStoreConfig.upsert({
      where: { shop },
      create: {
        shop,
        enabled,
        eventName,
        privateApiKeyEncrypted: encryptedKey,
        privateApiKeyLastFour: keyLastFour,
        connectionStatus,
      },
      update: {
        enabled,
        eventName,
        privateApiKeyEncrypted: encryptedKey,
        privateApiKeyLastFour: keyLastFour,
        connectionStatus,
        ...(submittedApiKey
          ? { accountId: null, lastValidatedAt: null, lastError: null }
          : {}),
      },
    });

    if (enabled) {
      await prisma.klaviyoEventOutbox.updateMany({
        where: {
          shop,
          OR: [
            { status: "BLOCKED" },
            {
              status: "DEAD",
              OR: [
                { lastError: { startsWith: "Klaviyo returned status 401" } },
                { lastError: { startsWith: "Klaviyo returned status 403" } },
              ],
            },
          ],
        },
        data: { status: "PENDING", attempts: 0, nextAttemptAt: null, lastError: null },
      });
    }

    return { ok: true, message: "Klaviyo settings saved for this store." };
  } catch (error) {
    return { ok: false, error: safeError(error) };
  }
};

function statusTone(status: string) {
  if (status === "CONNECTED" || status === "LEGACY_ENVIRONMENT") return "success" as const;
  if (status === "ERROR") return "critical" as const;
  if (status === "UNTESTED") return "warning" as const;
  return "neutral" as const;
}

export default function KlaviyoSettingsPage() {
  const settings = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const [enabled, setEnabled] = useState(settings.enabled);
  const [eventName, setEventName] = useState(settings.eventName);
  const [privateApiKey, setPrivateApiKey] = useState("");
  const busy = fetcher.state !== "idle";

  useEffect(() => {
    if (!fetcher.data?.ok) return;
    shopify.toast.show(fetcher.data.message);
    if (fetcher.formData?.get("intent") === "save") setPrivateApiKey("");
  }, [fetcher.data, fetcher.formData, shopify]);

  function submit(intent: "save" | "test") {
    const data = new FormData();
    data.set("intent", intent);
    data.set("enabled", String(enabled));
    data.set("eventName", eventName);
    data.set("privateApiKey", privateApiKey);
    fetcher.submit(data, { method: "post" });
  }

  const displayedStatus =
    fetcher.data?.ok && fetcher.data.accountId
      ? "CONNECTED"
      : settings.connectionStatus;

  return (
    <s-page heading="Klaviyo Integration" inlineSize="base">
      <s-stack direction="block" gap="base">
        <s-banner heading={`Store-specific configuration for ${settings.shop}`} tone="info">
          This page only manages the Klaviyo account connected to this authenticated Shopify store.
        </s-banner>

        {fetcher.data && !fetcher.data.ok && (
          <s-banner heading="Klaviyo configuration error" tone="critical">
            {fetcher.data.error}
          </s-banner>
        )}

        {!fetcher.data && settings.lastError && (
          <s-banner heading="Last Klaviyo error" tone="critical">
            {settings.lastError}
          </s-banner>
        )}

        <s-section heading="Connection">
          <s-stack direction="block" gap="base">
            <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="center">
              <s-stack direction="block" gap="small">
                <s-text type="strong">Connection status</s-text>
                <s-paragraph color="subdued">
                  Credentials are {settings.maskedKey}. Source: {settings.source}.
                </s-paragraph>
              </s-stack>
              <s-badge tone={statusTone(displayedStatus)}>{displayedStatus}</s-badge>
            </s-grid>

            <s-switch
              label="Enable Klaviyo integration"
              name="enabled"
              checked={enabled}
              onChange={(event) => setEnabled(event.currentTarget.checked ?? false)}
            ></s-switch>

            <s-password-field
              label="Klaviyo private API key"
              name="privateApiKey"
              value={privateApiKey}
              placeholder={
                settings.hasCredential
                  ? `Leave blank to keep ${settings.maskedKey}`
                  : "Enter a private API key"
              }
              autocomplete="off"
              onInput={(event) => setPrivateApiKey(event.currentTarget.value ?? "")}
            ></s-password-field>
            <s-paragraph color="subdued">
              The key is encrypted before it is stored and is never returned to the browser.
              Use a key with accounts:read and events:write scopes.
            </s-paragraph>

            <s-text-field
              label="Klaviyo event name"
              name="eventName"
              value={eventName}
              maxLength={191}
              onInput={(event) => setEventName(event.currentTarget.value ?? "")}
            ></s-text-field>

            {settings.accountId && (
              <s-paragraph color="subdued">
                Connected Klaviyo account ID: {settings.accountId}
              </s-paragraph>
            )}
            {settings.lastValidatedAt && (
              <s-paragraph color="subdued">
                Last validated: {new Date(settings.lastValidatedAt).toLocaleString()}
              </s-paragraph>
            )}

            <s-button-group>
              <s-button variant="primary" disabled={busy} onClick={() => submit("save")}>
                Save settings
              </s-button>
              <s-button disabled={busy} onClick={() => submit("test")}>
                Test connection
              </s-button>
            </s-button-group>
          </s-stack>
        </s-section>
      </s-stack>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
