import { useEffect, useMemo, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData, useRouteError } from "react-router";
import { SaveBar, useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";

import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import styles from "../campaign-settings.module.css";

type CampaignStatus = "Draft" | "Scheduled" | "Active" | "Ended";
type FormValues = {
  startDate: string;
  endDate: string;
  enabled: boolean;
  checkoutEntryMessageEn: string;
  checkoutTicketMessageEn: string;
  checkoutMotivationMessageEn: string;
  checkoutEntryMessageFr: string;
  checkoutTicketMessageFr: string;
  checkoutMotivationMessageFr: string;
  thankYouMessageEn: string;
  thankYouMessageFr: string;
};
type FieldErrors = Partial<Record<keyof FormValues, string>>;
type ActionData =
  | { ok: true; status: CampaignStatus; values: FormValues }
  | { ok: false; error: string; fieldErrors: FieldErrors };

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const CAMPAIGN_NAME = "Black Friday Giveaway";
const MAX_MESSAGE_LENGTH = 500;
const CHECKOUT_METAFIELD_KEY = "black_friday_checkout_config";
const DEFAULTS = {
  checkoutEntryMessageEn: "You're entered in our Black Friday Giveaway!",
  checkoutTicketMessageEn:
    "This order earns you {tickets} tickets. Your total will be {total-tickets} tickets.",
  checkoutMotivationMessageEn:
    "The more tickets you have, the higher your chances to win a trip to Asia.",
  checkoutEntryMessageFr: "Vous participez à notre concours du Vendredi fou !",
  checkoutTicketMessageFr:
    "Cette commande vous rapporte {tickets} billets. Votre total sera de {total-tickets} billets.",
  checkoutMotivationMessageFr:
    "Plus vous avez de billets, plus vous avez de chances de gagner un voyage en Asie.",
  thankYouMessageEn:
    "You're In! Black Friday Giveaway\n\nThank you for your order!\nYou earn total {tickets-num} tickets.\nMore tickets, more chances to win a dream trip to Asia!",
  thankYouMessageFr:
    "Vous participez au concours du Vendredi fou !\n\nMerci pour votre commande !\nVous gagnez un total de {tickets-num} billets.\nPlus de billets, plus de chances de gagner un voyage de rêve en Asie !",
};

function formatInTimezone(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return {
    date: `${value.year}-${value.month}-${value.day}`,
    time: `${value.hour}:${value.minute}`,
  };
}

function formatDateRange(startDate: string, endDate: string) {
  const toUtcDate = (value: string) => {
    const [year, month, day] = value.split("-").map(Number);
    return new Date(Date.UTC(year, month - 1, day));
  };
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  return formatter.formatRange(toUtcDate(startDate), toUtcDate(endDate));
}

function zonedDateTimeToUtc(date: string, time: string, timezone: string) {
  if (!DATE_PATTERN.test(date) || !TIME_PATTERN.test(time)) return null;
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const target = Date.UTC(year, month - 1, day, hour, minute);
  let candidate = target;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const rendered = formatInTimezone(new Date(candidate), timezone);
    const [renderedYear, renderedMonth, renderedDay] = rendered.date
      .split("-")
      .map(Number);
    const [renderedHour, renderedMinute] = rendered.time.split(":").map(Number);
    const renderedAsUtc = Date.UTC(
      renderedYear,
      renderedMonth - 1,
      renderedDay,
      renderedHour,
      renderedMinute,
    );
    const adjustment = target - renderedAsUtc;
    candidate += adjustment;
    if (adjustment === 0) break;
  }
  const result = new Date(candidate);
  const roundTrip = formatInTimezone(result, timezone);
  return roundTrip.date === date && roundTrip.time === time ? result : null;
}

function deriveStatus(
  settings: {
    enabled: boolean;
    startDate: Date | null;
    endDate: Date | null;
  } | null,
  now = new Date(),
): CampaignStatus {
  if (!settings?.enabled || !settings.startDate || !settings.endDate)
    return "Draft";
  if (now < settings.startDate) return "Scheduled";
  if (now > settings.endDate) return "Ended";
  return "Active";
}

function badgeTone(status: CampaignStatus) {
  if (status === "Active") return "success" as const;
  if (status === "Scheduled") return "info" as const;
  if (status === "Ended") return "critical" as const;
  return "neutral" as const;
}

function statusDescription(status: CampaignStatus) {
  if (status === "Active") return "Customers can currently see the giveaway.";
  if (status === "Scheduled") return "The giveaway will start automatically.";
  if (status === "Ended") return "The configured giveaway period has ended.";
  return "Enable your campaign to make it live for customers.";
}

function toFormValues(
  settings: {
    enabled: boolean;
    startDate: Date | null;
    endDate: Date | null;
    englishMessage: string;
    frenchMessage: string;
    englishTicketMessage: string;
    frenchTicketMessage: string;
    englishMotivationMessage: string;
    frenchMotivationMessage: string;
    englishThankYouMessage: string;
    frenchThankYouMessage: string;
  } | null,
  timezone: string,
): FormValues {
  return {
    startDate: settings?.startDate
      ? formatInTimezone(settings.startDate, timezone).date
      : "",
    endDate: settings?.endDate
      ? formatInTimezone(settings.endDate, timezone).date
      : "",
    enabled: settings?.enabled ?? false,
    checkoutEntryMessageEn:
      settings?.englishMessage ?? DEFAULTS.checkoutEntryMessageEn,
    checkoutTicketMessageEn:
      settings?.englishTicketMessage ?? DEFAULTS.checkoutTicketMessageEn,
    checkoutMotivationMessageEn:
      settings?.englishMotivationMessage ??
      DEFAULTS.checkoutMotivationMessageEn,
    checkoutEntryMessageFr:
      settings?.frenchMessage ?? DEFAULTS.checkoutEntryMessageFr,
    checkoutTicketMessageFr:
      settings?.frenchTicketMessage ?? DEFAULTS.checkoutTicketMessageFr,
    checkoutMotivationMessageFr:
      settings?.frenchMotivationMessage ?? DEFAULTS.checkoutMotivationMessageFr,
    thankYouMessageEn:
      settings?.englishThankYouMessage ?? DEFAULTS.thankYouMessageEn,
    thankYouMessageFr:
      settings?.frenchThankYouMessage ?? DEFAULTS.thankYouMessageFr,
  };
}

function formString(formData: FormData, key: string) {
  return String(formData.get(key) ?? "");
}

async function getShopContext(
  admin: Awaited<ReturnType<typeof authenticate.admin>>["admin"],
) {
  const response = await admin.graphql(
    `#graphql
      query CampaignShopContext {
        shop {
          id
          name
          ianaTimezone
        }
      }`,
  );
  const json = await response.json();
  return json.data!.shop;
}

async function syncCheckoutCampaignConfig(
  admin: Awaited<ReturnType<typeof authenticate.admin>>["admin"],
  ownerId: string,
  settings: {
    enabled: boolean;
    startDate: Date | null;
    endDate: Date | null;
    timezone: string;
    englishMessage: string;
    frenchMessage: string;
    englishTicketMessage: string;
    frenchTicketMessage: string;
    englishMotivationMessage: string;
    frenchMotivationMessage: string;
    englishThankYouMessage: string;
    frenchThankYouMessage: string;
  },
) {
  const response = await admin.graphql(
    `#graphql
      mutation SyncBlackFridayCheckoutConfig($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields {
            id
          }
          userErrors {
            field
            message
          }
        }
      }`,
    {
      variables: {
        metafields: [
          {
            ownerId,
            namespace: "$app",
            key: CHECKOUT_METAFIELD_KEY,
            type: "json",
            value: JSON.stringify({
              version: 1,
              enabled: settings.enabled,
              startAt: settings.startDate?.toISOString() ?? null,
              endAt: settings.endDate?.toISOString() ?? null,
              timezone: settings.timezone,
              ticketTotalUrl: process.env.SHOPIFY_APP_URL
                ? `${process.env.SHOPIFY_APP_URL.replace(/\/$/, "")}/api/checkout-ticket-total`
                : null,
              thankYouUrl: process.env.SHOPIFY_APP_URL
                ? `${process.env.SHOPIFY_APP_URL.replace(/\/$/, "")}/api/thank-you-giveaway`
                : null,
              messages: {
                en: {
                  entry: settings.englishMessage,
                  tickets: settings.englishTicketMessage,
                  motivation: settings.englishMotivationMessage,
                },
                fr: {
                  entry: settings.frenchMessage,
                  tickets: settings.frenchTicketMessage,
                  motivation: settings.frenchMotivationMessage,
                },
              },
              thankYouMessages: {
                en: settings.englishThankYouMessage,
                fr: settings.frenchThankYouMessage,
              },
            }),
          },
        ],
      },
    },
  );
  const json = await response.json();
  const userErrors = json.data?.metafieldsSet?.userErrors ?? [];
  if (userErrors.length) {
    throw new Error(
      userErrors.map((error: { message: string }) => error.message).join(" "),
    );
  }
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const [shop, settings] = await Promise.all([
    getShopContext(admin),
    prisma.campaignSettings.findUnique({ where: { shop: session.shop } }),
  ]);
  return {
    shopName: shop.name,
    timezone: shop.ianaTimezone,
    status: deriveStatus(settings),
    values: toFormValues(settings, shop.ianaTimezone),
  };
};

export const action = async ({
  request,
}: ActionFunctionArgs): Promise<ActionData> => {
  const { admin, session } = await authenticate.admin(request);
  const shop = await getShopContext(admin);
  const formData = await request.formData();
  const values: FormValues = {
    startDate: formString(formData, "startDate").trim(),
    endDate: formString(formData, "endDate").trim(),
    enabled: formData.get("enabled") === "true",
    checkoutEntryMessageEn: formString(formData, "checkoutEntryMessageEn"),
    checkoutTicketMessageEn: formString(formData, "checkoutTicketMessageEn"),
    checkoutMotivationMessageEn: formString(
      formData,
      "checkoutMotivationMessageEn",
    ),
    checkoutEntryMessageFr: formString(formData, "checkoutEntryMessageFr"),
    checkoutTicketMessageFr: formString(formData, "checkoutTicketMessageFr"),
    checkoutMotivationMessageFr: formString(
      formData,
      "checkoutMotivationMessageFr",
    ),
    thankYouMessageEn: formString(formData, "thankYouMessageEn"),
    thankYouMessageFr: formString(formData, "thankYouMessageFr"),
  };
  const fieldErrors: FieldErrors = {};
  const needsSchedule =
    values.enabled || Boolean(values.startDate || values.endDate);
  if (needsSchedule && !DATE_PATTERN.test(values.startDate))
    fieldErrors.startDate = "Select a start date.";
  if (needsSchedule && !DATE_PATTERN.test(values.endDate))
    fieldErrors.endDate = "Select an end date.";
  for (const key of [
    "checkoutEntryMessageEn",
    "checkoutTicketMessageEn",
    "checkoutMotivationMessageEn",
    "checkoutEntryMessageFr",
    "checkoutTicketMessageFr",
    "checkoutMotivationMessageFr",
    "thankYouMessageEn",
    "thankYouMessageFr",
  ] as const) {
    if (values[key].length > MAX_MESSAGE_LENGTH)
      fieldErrors[key] =
        `Keep this message under ${MAX_MESSAGE_LENGTH} characters.`;
  }
  for (const key of [
    "checkoutTicketMessageEn",
    "checkoutTicketMessageFr",
  ] as const) {
    if (
      !values[key].includes("{tickets}") ||
      !values[key].includes("{total-tickets}")
    )
      fieldErrors[key] =
        "Include {tickets} and {total-tickets} so the app can insert both counts.";
  }
  for (const key of ["thankYouMessageEn", "thankYouMessageFr"] as const) {
    if (!values[key].includes("{tickets-num}"))
      fieldErrors[key] =
        "Include {tickets-num} so the app can insert the Shopify cart total as the ticket count.";
  }

  let startDate: Date | null = null;
  let endDate: Date | null = null;
  if (
    DATE_PATTERN.test(values.startDate) &&
    DATE_PATTERN.test(values.endDate)
  ) {
    startDate = zonedDateTimeToUtc(
      values.startDate,
      "00:00",
      shop.ianaTimezone,
    );
    const lastMinute = zonedDateTimeToUtc(
      values.endDate,
      "23:59",
      shop.ianaTimezone,
    );
    endDate = lastMinute ? new Date(lastMinute.getTime() + 59_999) : null;
    if (!startDate)
      fieldErrors.startDate = "This date is unavailable in the store timezone.";
    if (!endDate)
      fieldErrors.endDate = "This date is unavailable in the store timezone.";
    if (startDate && endDate && endDate <= startDate)
      fieldErrors.endDate = "End date cannot be before the start date.";
  }
  if (Object.keys(fieldErrors).length) {
    return {
      ok: false,
      error: "Correct the highlighted fields and try again.",
      fieldErrors,
    };
  }

  const saved = await prisma.campaignSettings.upsert({
    where: { shop: session.shop },
    create: {
      shop: session.shop,
      campaignName: CAMPAIGN_NAME,
      timezone: shop.ianaTimezone,
      enabled: values.enabled,
      startDate,
      endDate,
      englishMessage: values.checkoutEntryMessageEn,
      frenchMessage: values.checkoutEntryMessageFr,
      englishTicketMessage: values.checkoutTicketMessageEn,
      frenchTicketMessage: values.checkoutTicketMessageFr,
      englishMotivationMessage: values.checkoutMotivationMessageEn,
      frenchMotivationMessage: values.checkoutMotivationMessageFr,
      englishThankYouMessage: values.thankYouMessageEn,
      frenchThankYouMessage: values.thankYouMessageFr,
    },
    update: {
      timezone: shop.ianaTimezone,
      enabled: values.enabled,
      startDate,
      endDate,
      englishMessage: values.checkoutEntryMessageEn,
      frenchMessage: values.checkoutEntryMessageFr,
      englishTicketMessage: values.checkoutTicketMessageEn,
      frenchTicketMessage: values.checkoutTicketMessageFr,
      englishMotivationMessage: values.checkoutMotivationMessageEn,
      frenchMotivationMessage: values.checkoutMotivationMessageFr,
      englishThankYouMessage: values.thankYouMessageEn,
      frenchThankYouMessage: values.thankYouMessageFr,
    },
  });
  try {
    await syncCheckoutCampaignConfig(admin, shop.id, saved);
  } catch (error) {
    console.error("Checkout campaign metafield sync failed", error);
    return {
      ok: false,
      error:
        "Settings were saved, but checkout could not be updated. Save again to retry.",
      fieldErrors: {},
    };
  }
  return {
    ok: true,
    status: deriveStatus(saved),
    values: toFormValues(saved, shop.ianaTimezone),
  };
};

function SummaryCard({
  icon,
  title,
  color,
  children,
}: {
  icon: "status" | "calendar" | "view";
  title: string;
  color: "green" | "purple" | "blue";
  children: React.ReactNode;
}) {
  const colorStyle = {
    green: {
      background: "linear-gradient(135deg, #e8f8ee 0%, #d5f2df 100%)",
      borderColor: "#9bd5af",
    },
    purple: {
      background: "linear-gradient(135deg, #f2eafe 0%, #e7d8fb 100%)",
      borderColor: "#c7a6ee",
    },
    blue: {
      background: "linear-gradient(135deg, #e8f3ff 0%, #d8eaff 100%)",
      borderColor: "#9fc7f4",
    },
  }[color];

  return (
    <div
      style={{
        height: "100%",
        boxSizing: "border-box",
        padding: 18,
        border: "1px solid",
        borderRadius: 14,
        ...colorStyle,
      }}
    >
      <s-stack direction="block" gap="small">
        <s-stack direction="inline" gap="small" alignItems="center">
          <s-icon type={icon} tone="neutral"></s-icon>
          <s-text type="strong">{title}</s-text>
        </s-stack>
        {children}
      </s-stack>
    </div>
  );
}

export default function CampaignSettingsPage() {
  const loaderData = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const [form, setForm] = useState<FormValues>(loaderData.values);
  const [baseline, setBaseline] = useState<FormValues>(loaderData.values);
  const [formVersion, setFormVersion] = useState(0);
  const [clientErrors, setClientErrors] = useState<FieldErrors>({});
  const [language, setLanguage] = useState<"en" | "fr">("en");
  const actionData = fetcher.data;
  const saving = fetcher.state === "submitting";
  const dirty = useMemo(
    () => JSON.stringify(form) !== JSON.stringify(baseline),
    [form, baseline],
  );
  const status = actionData?.ok ? actionData.status : loaderData.status;
  const serverErrors =
    actionData && !actionData.ok ? actionData.fieldErrors : {};
  const errors = { ...serverErrors, ...clientErrors };

  useEffect(() => {
    if (!actionData?.ok) return;
    setForm(actionData.values);
    setBaseline(actionData.values);
    setFormVersion((version) => version + 1);
    setClientErrors({});
    shopify.toast.show("Campaign settings saved");
  }, [actionData, shopify]);

  function update<K extends keyof FormValues>(key: K, value: FormValues[K]) {
    setForm((current) => ({ ...current, [key]: value }));
    setClientErrors((current) => ({ ...current, [key]: undefined }));
  }

  function save() {
    const nextErrors: FieldErrors = {};
    if (form.enabled && !form.startDate)
      nextErrors.startDate = "Select a start date.";
    if (form.enabled && !form.endDate)
      nextErrors.endDate = "Select an end date.";
    if (form.startDate && form.endDate && form.endDate < form.startDate)
      nextErrors.endDate = "End date cannot be before the start date.";
    for (const key of [
      "checkoutEntryMessageEn",
      "checkoutTicketMessageEn",
      "checkoutMotivationMessageEn",
      "checkoutEntryMessageFr",
      "checkoutTicketMessageFr",
      "checkoutMotivationMessageFr",
      "thankYouMessageEn",
      "thankYouMessageFr",
    ] as const) {
      if (form[key].length > MAX_MESSAGE_LENGTH)
        nextErrors[key] =
          `Keep this message under ${MAX_MESSAGE_LENGTH} characters.`;
    }
    for (const key of [
      "checkoutTicketMessageEn",
      "checkoutTicketMessageFr",
    ] as const) {
      if (
        !form[key].includes("{tickets}") ||
        !form[key].includes("{total-tickets}")
      )
        nextErrors[key] =
          "Include {tickets} and {total-tickets} so the app can insert both counts.";
    }
    for (const key of ["thankYouMessageEn", "thankYouMessageFr"] as const) {
      if (!form[key].includes("{tickets-num}"))
        nextErrors[key] =
          "Include {tickets-num} so the app can insert the Shopify cart total as the ticket count.";
    }
    setClientErrors(nextErrors);
    if (Object.keys(nextErrors).length) return;
    const data = new FormData();
    Object.entries(form).forEach(([key, value]) =>
      data.set(key, String(value)),
    );
    fetcher.submit(data, { method: "post" });
  }

  function discard() {
    setForm(baseline);
    setClientErrors({});
    setFormVersion((version) => version + 1);
  }

  const savedDates =
    baseline.startDate && baseline.endDate
      ? formatDateRange(baseline.startDate, baseline.endDate)
      : "Not scheduled";
  const checkoutVisible = baseline.enabled && status === "Active";
  const checkoutPreview =
    language === "en"
      ? {
          confirmation: form.checkoutEntryMessageEn,
          tickets: form.checkoutTicketMessageEn
            .replaceAll("{tickets}", "47")
            .replaceAll("{total-tickets}", "47"),
          motivation: form.checkoutMotivationMessageEn,
        }
      : {
          confirmation: form.checkoutEntryMessageFr,
          tickets: form.checkoutTicketMessageFr
            .replaceAll("{tickets}", "47")
            .replaceAll("{total-tickets}", "47"),
          motivation: form.checkoutMotivationMessageFr,
        };
  const thankYouPreviewLines = (
    language === "en" ? form.thankYouMessageEn : form.thankYouMessageFr
  )
    .replaceAll("{tickets-num}", "47")
    .replaceAll("{tickets}", "47")
    .split(/\n+/)
    .filter(Boolean);

  return (
    <s-page heading="Campaign Settings" inlineSize="large">
      <SaveBar open={dirty} discardConfirmation>
        <button variant="primary" onClick={save} disabled={saving}>
          Save Campaign
        </button>
        <button onClick={discard} disabled={saving}>
          Discard
        </button>
      </SaveBar>

      <s-stack direction="block" gap="base">
        <div
          style={{
            position: "relative",
            height: 132,
            overflow: "hidden",
            borderRadius: 18,
            background:
              "radial-gradient(circle at 78% 30%, rgba(147, 51, 234, 0.38), transparent 34%), linear-gradient(120deg, #09070d 0%, #171020 52%, #30104d 100%)",
            color: "#ffffff",
            boxShadow: "0 12px 36px rgba(34, 12, 52, 0.18)",
          }}
        >
          <div
            style={{
              position: "relative",
              zIndex: 2,
              maxWidth: 520,
              padding: "16px 24px",
            }}
          >
            <s-badge tone={badgeTone(status)}>{status}</s-badge>
            <h1
              style={{
                margin: "7px 0 5px",
                color: "#ffffff",
                fontSize: "clamp(22px, 2.8vw, 30px)",
                lineHeight: 1.05,
                letterSpacing: "-0.035em",
              }}
            >
              Black Friday Giveaway
            </h1>
            <p
              style={{
                maxWidth: 480,
                margin: 0,
                color: "rgba(255, 255, 255, 0.78)",
                fontSize: 13,
                lineHeight: 1.35,
              }}
            >
              Set up your campaign dates and customer messages to create an
              exciting Black Friday shopping experience.
            </p>
          </div>
          <img
            style={{
              position: "absolute",
              zIndex: 1,
              right: -18,
              bottom: -68,
              width: "min(38%, 340px)",
              pointerEvents: "none",
              filter: "drop-shadow(0 18px 24px rgba(0, 0, 0, 0.35))",
            }}
            src="/black-friday-gift.png"
            alt=""
            aria-hidden="true"
          />
        </div>

        <s-query-container>
          <s-grid gridTemplateColumns="repeat(3, minmax(0, 1fr))" gap="base">
            <SummaryCard icon="status" title="Campaign status" color="green">
              <s-badge tone={badgeTone(status)}>{status}</s-badge>
              <s-paragraph color="subdued">
                {statusDescription(status)}
              </s-paragraph>
            </SummaryCard>
            <SummaryCard icon="calendar" title="Giveaway dates" color="purple">
              <s-text type="strong">{savedDates}</s-text>
              <s-paragraph color="subdued">
                Store timezone: {loaderData.timezone}
              </s-paragraph>
            </SummaryCard>
            <SummaryCard icon="view" title="Checkout visibility" color="blue">
              <s-badge tone={checkoutVisible ? "success" : "neutral"}>
                {checkoutVisible ? "Visible" : "Hidden"}
              </s-badge>
              <s-paragraph color="subdued">
                {checkoutVisible
                  ? "Enabled and currently active."
                  : baseline.enabled
                    ? "Enabled, but outside its active dates."
                    : "Message will display on checkout when the campaign is active."}
              </s-paragraph>
            </SummaryCard>
          </s-grid>
        </s-query-container>

        {actionData && !actionData.ok && (
          <s-banner heading="Settings could not be saved" tone="critical">
            {actionData.error}
          </s-banner>
        )}
      </s-stack>

      <div style={{ marginTop: 20 }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 7fr) minmax(280px, 3fr)",
            columnGap: 16,
            alignItems: "start",
            width: "100%",
          }}
        >
          <div style={{ gridColumn: "1 / 2", minWidth: 0 }}>
            <s-stack direction="block" gap="base" key={formVersion}>
              <s-section heading="Schedule">
                <s-stack direction="block" gap="base">
                  <s-paragraph color="subdued">
                    Set the start and end dates for your Black Friday Giveaway
                    campaign.
                  </s-paragraph>
                  <s-query-container>
                    <s-grid
                      gridTemplateColumns="minmax(0, 1fr) minmax(0, 1fr) auto"
                      gap="base"
                      alignItems="end"
                    >
                      <s-date-field
                        label="Start date"
                        name="startDate"
                        value={form.startDate}
                        error={errors.startDate}
                        required={form.enabled}
                        onChange={(event) =>
                          update("startDate", event.currentTarget.value ?? "")
                        }
                      ></s-date-field>
                      <s-date-field
                        label="End date"
                        name="endDate"
                        value={form.endDate}
                        error={errors.endDate}
                        required={form.enabled}
                        onChange={(event) =>
                          update("endDate", event.currentTarget.value ?? "")
                        }
                      ></s-date-field>
                      <div className={styles.enableControl}>
                        <s-switch
                          label="Enable campaign"
                          name="enabled"
                          defaultChecked={form.enabled}
                          onChange={(event) =>
                            update(
                              "enabled",
                              event.currentTarget.checked ?? false,
                            )
                          }
                        ></s-switch>
                      </div>
                    </s-grid>
                  </s-query-container>
                </s-stack>
              </s-section>
              <s-box
                padding="base"
                background="subdued"
                border="base"
                borderRadius="base"
              >
                <s-stack direction="block" gap="base">
                  <s-heading>Checkout Information</s-heading>
                  <s-paragraph color="subdued">
                    These messages will appear on the checkout page during the
                    giveaway campaign.
                  </s-paragraph>
                  <s-query-container>
                    <s-grid
                      gridTemplateColumns="repeat(2, minmax(0, 1fr))"
                      gap="base"
                    >
                      <s-stack direction="block" gap="small">
                        <s-text-area
                          label="English entry confirmation"
                          name="checkoutEntryMessageEn"
                          defaultValue={form.checkoutEntryMessageEn}
                          rows={2}
                          maxLength={MAX_MESSAGE_LENGTH}
                          error={errors.checkoutEntryMessageEn}
                          onInput={(event) =>
                            update(
                              "checkoutEntryMessageEn",
                              event.currentTarget.value ?? "",
                            )
                          }
                        ></s-text-area>
                        <s-text-area
                          label="English ticket message"
                          name="checkoutTicketMessageEn"
                          defaultValue={form.checkoutTicketMessageEn}
                          rows={2}
                          maxLength={MAX_MESSAGE_LENGTH}
                          error={errors.checkoutTicketMessageEn}
                          onInput={(event) =>
                            update(
                              "checkoutTicketMessageEn",
                              event.currentTarget.value ?? "",
                            )
                          }
                        ></s-text-area>
                        <s-text-area
                          label="English motivation message"
                          name="checkoutMotivationMessageEn"
                          defaultValue={form.checkoutMotivationMessageEn}
                          rows={2}
                          maxLength={MAX_MESSAGE_LENGTH}
                          error={errors.checkoutMotivationMessageEn}
                          onInput={(event) =>
                            update(
                              "checkoutMotivationMessageEn",
                              event.currentTarget.value ?? "",
                            )
                          }
                        ></s-text-area>
                      </s-stack>
                      <s-stack direction="block" gap="small">
                        <s-text-area
                          label="French entry confirmation"
                          name="checkoutEntryMessageFr"
                          defaultValue={form.checkoutEntryMessageFr}
                          rows={2}
                          maxLength={MAX_MESSAGE_LENGTH}
                          error={errors.checkoutEntryMessageFr}
                          onInput={(event) =>
                            update(
                              "checkoutEntryMessageFr",
                              event.currentTarget.value ?? "",
                            )
                          }
                        ></s-text-area>
                        <s-text-area
                          label="French ticket message"
                          name="checkoutTicketMessageFr"
                          defaultValue={form.checkoutTicketMessageFr}
                          rows={2}
                          maxLength={MAX_MESSAGE_LENGTH}
                          error={errors.checkoutTicketMessageFr}
                          onInput={(event) =>
                            update(
                              "checkoutTicketMessageFr",
                              event.currentTarget.value ?? "",
                            )
                          }
                        ></s-text-area>
                        <s-text-area
                          label="French motivation message"
                          name="checkoutMotivationMessageFr"
                          defaultValue={form.checkoutMotivationMessageFr}
                          rows={2}
                          maxLength={MAX_MESSAGE_LENGTH}
                          error={errors.checkoutMotivationMessageFr}
                          onInput={(event) =>
                            update(
                              "checkoutMotivationMessageFr",
                              event.currentTarget.value ?? "",
                            )
                          }
                        ></s-text-area>
                      </s-stack>
                    </s-grid>
                    <s-paragraph color="subdued">
                      Use {"{tickets}"} for this order and {"{total-tickets}"}
                      for the customer total.
                    </s-paragraph>
                  </s-query-container>
                </s-stack>
              </s-box>

              <s-box
                padding="base"
                background="subdued"
                border="base"
                borderRadius="base"
              >
                <s-stack direction="block" gap="base">
                  <s-heading>Thank You Page Messages</s-heading>
                  <s-paragraph color="subdued">
                    These messages will appear on the order confirmation page
                    after a successful purchase.
                  </s-paragraph>
                  <s-query-container>
                    <s-grid
                      gridTemplateColumns="repeat(2, minmax(0, 1fr))"
                      gap="base"
                    >
                      <s-stack direction="block" gap="small">
                        <s-text-area
                          label="English Thank You message"
                          name="thankYouMessageEn"
                          defaultValue={form.thankYouMessageEn}
                          rows={5}
                          maxLength={MAX_MESSAGE_LENGTH}
                          error={errors.thankYouMessageEn}
                          onInput={(event) =>
                            update(
                              "thankYouMessageEn",
                              event.currentTarget.value ?? "",
                            )
                          }
                        ></s-text-area>
                      </s-stack>
                      <s-stack direction="block" gap="small">
                        <s-text-area
                          label="French Thank You message"
                          name="thankYouMessageFr"
                          defaultValue={form.thankYouMessageFr}
                          rows={5}
                          maxLength={MAX_MESSAGE_LENGTH}
                          error={errors.thankYouMessageFr}
                          onInput={(event) =>
                            update(
                              "thankYouMessageFr",
                              event.currentTarget.value ?? "",
                            )
                          }
                        ></s-text-area>
                      </s-stack>
                    </s-grid>
                  </s-query-container>
                </s-stack>
              </s-box>
            </s-stack>
          </div>

          <div
            style={{
              gridColumn: "2 / 3",
              minWidth: 0,
              position: "sticky",
              top: 16,
              alignSelf: "start",
            }}
          >
            <s-section heading="Customer Experience Preview">
              <s-stack direction="block" gap="base">
                <s-button-group accessibilityLabel="Preview language">
                  <s-press-button
                    pressed={language === "en"}
                    onClick={() => setLanguage("en")}
                  >
                    English
                  </s-press-button>
                  <s-press-button
                    pressed={language === "fr"}
                    onClick={() => setLanguage("fr")}
                  >
                    Français
                  </s-press-button>
                </s-button-group>
                <s-box
                  padding="small"
                  background="subdued"
                  borderRadius="base"
                  border="base"
                >
                  <s-stack direction="block" gap="none">
                    <s-text>{checkoutPreview.confirmation}</s-text>
                    <s-text type="strong">{checkoutPreview.tickets}</s-text>
                    <s-text color="subdued">
                      {checkoutPreview.motivation}
                    </s-text>
                  </s-stack>
                </s-box>
                <s-paragraph color="subdued">
                  Preview only. Your Shopify checkout layout is not modified.
                </s-paragraph>
              </s-stack>
            </s-section>

            <div style={{ marginTop: 16 }}>
              <s-section heading="Thank You Page Preview">
                <s-box
                  padding="small"
                  background="subdued"
                  borderRadius="base"
                  border="base"
                >
                  <s-stack direction="block" gap="small">
                    {thankYouPreviewLines.map((line, index) =>
                      index === 0 || line.includes("🎟️") ? (
                        <s-text type="strong" key={`${index}-${line}`}>
                          {line}
                        </s-text>
                      ) : (
                        <s-text key={`${index}-${line}`}>{line}</s-text>
                      ),
                    )}
                  </s-stack>
                </s-box>
                <s-paragraph color="subdued">
                  Preview only. The Shopify cart total replaces{" "}
                  {"{tickets-num}"}.
                </s-paragraph>
              </s-section>
            </div>
          </div>
        </div>
      </div>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}
export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
