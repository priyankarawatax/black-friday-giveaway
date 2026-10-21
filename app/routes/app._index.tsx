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
  checkoutMessageEn: string;
  checkoutMessageFr: string;
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
const DEFAULTS = {
  checkoutMessageEn:
    "You're entering our Black Friday Giveaway. Complete your checkout to confirm your entry. Terms and conditions apply.",
  checkoutMessageFr:
    "Vous participez à notre concours du Vendredi fou. Finalisez votre paiement pour confirmer votre participation. Des conditions s'appliquent.",
  thankYouMessageEn:
    "Thank you for your order! Your entry into our Black Friday Giveaway has been confirmed. Good luck!",
  thankYouMessageFr:
    "Merci pour votre commande ! Votre participation à notre concours du Vendredi fou est confirmée. Bonne chance !",
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
    checkoutMessageEn: settings?.englishMessage ?? DEFAULTS.checkoutMessageEn,
    checkoutMessageFr: settings?.frenchMessage ?? DEFAULTS.checkoutMessageFr,
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
          name
          ianaTimezone
        }
      }`,
  );
  const json = await response.json();
  return json.data!.shop;
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
    checkoutMessageEn: formString(formData, "checkoutMessageEn"),
    checkoutMessageFr: formString(formData, "checkoutMessageFr"),
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
    "checkoutMessageEn",
    "checkoutMessageFr",
    "thankYouMessageEn",
    "thankYouMessageFr",
  ] as const) {
    if (values[key].length > MAX_MESSAGE_LENGTH)
      fieldErrors[key] =
        `Keep this message under ${MAX_MESSAGE_LENGTH} characters.`;
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
      englishMessage: values.checkoutMessageEn,
      frenchMessage: values.checkoutMessageFr,
      englishThankYouMessage: values.thankYouMessageEn,
      frenchThankYouMessage: values.thankYouMessageFr,
    },
    update: {
      timezone: shop.ianaTimezone,
      enabled: values.enabled,
      startDate,
      endDate,
      englishMessage: values.checkoutMessageEn,
      frenchMessage: values.checkoutMessageFr,
      englishThankYouMessage: values.thankYouMessageEn,
      frenchThankYouMessage: values.thankYouMessageFr,
    },
  });
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
  const colorClass = {
    green: styles.summaryGreen,
    purple: styles.summaryPurple,
    blue: styles.summaryBlue,
  }[color];

  return (
    <div className={`${styles.summaryCard} ${colorClass}`}>
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
  const [previewMode, setPreviewMode] = useState<"checkout" | "thankYou">(
    "checkout",
  );
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
      "checkoutMessageEn",
      "checkoutMessageFr",
      "thankYouMessageEn",
      "thankYouMessageFr",
    ] as const) {
      if (form[key].length > MAX_MESSAGE_LENGTH)
        nextErrors[key] =
          `Keep this message under ${MAX_MESSAGE_LENGTH} characters.`;
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
  const previewMessage =
    previewMode === "checkout"
      ? language === "en"
        ? form.checkoutMessageEn
        : form.checkoutMessageFr
      : language === "en"
        ? form.thankYouMessageEn
        : form.thankYouMessageFr;

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
        <div className={styles.hero}>
          <div className={styles.heroContent}>
            <s-badge tone={badgeTone(status)}>{status}</s-badge>
            <h1 className={styles.heroTitle}>Black Friday Giveaway</h1>
            <p className={styles.heroDescription}>
              Set up your campaign dates and customer messages to create an
              exciting Black Friday shopping experience.
            </p>
          </div>
          <img
            className={styles.heroArtwork}
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

      <div className={styles.contentLayout}>
        <s-query-container>
          <s-grid
            gridTemplateColumns="minmax(0, 7fr) minmax(0, 3fr)"
            gap="base"
            alignItems="start"
          >
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
                          update("startDate", event.currentTarget.value)
                        }
                      ></s-date-field>
                      <s-date-field
                        label="End date"
                        name="endDate"
                        value={form.endDate}
                        error={errors.endDate}
                        required={form.enabled}
                        onChange={(event) =>
                          update("endDate", event.currentTarget.value)
                        }
                      ></s-date-field>
                      <div className={styles.enableControl}>
                        <s-switch
                          label="Enable campaign"
                          name="enabled"
                          defaultChecked={form.enabled}
                          onChange={(event) =>
                            update("enabled", event.currentTarget.checked)
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
                          label="English checkout information"
                          name="checkoutMessageEn"
                          defaultValue={form.checkoutMessageEn}
                          rows={5}
                          maxLength={MAX_MESSAGE_LENGTH}
                          error={errors.checkoutMessageEn}
                          onInput={(event) =>
                            update(
                              "checkoutMessageEn",
                              event.currentTarget.value,
                            )
                          }
                        ></s-text-area>
                      </s-stack>
                      <s-stack direction="block" gap="small">
                        <s-text-area
                          label="French checkout information"
                          name="checkoutMessageFr"
                          defaultValue={form.checkoutMessageFr}
                          rows={5}
                          maxLength={MAX_MESSAGE_LENGTH}
                          error={errors.checkoutMessageFr}
                          onInput={(event) =>
                            update(
                              "checkoutMessageFr",
                              event.currentTarget.value,
                            )
                          }
                        ></s-text-area>
                      </s-stack>
                    </s-grid>
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
                              event.currentTarget.value,
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
                              event.currentTarget.value,
                            )
                          }
                        ></s-text-area>
                      </s-stack>
                    </s-grid>
                  </s-query-container>
                </s-stack>
              </s-box>
            </s-stack>

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
                <s-button-group accessibilityLabel="Preview mode">
                  <s-press-button
                    pressed={previewMode === "checkout"}
                    onClick={() => setPreviewMode("checkout")}
                  >
                    Checkout
                  </s-press-button>
                  <s-press-button
                    pressed={previewMode === "thankYou"}
                    onClick={() => setPreviewMode("thankYou")}
                  >
                    Thank You
                  </s-press-button>
                </s-button-group>
                <s-box background="subdued" borderRadius="base">
                  <s-stack direction="block">
                    <s-box
                      padding="base"
                      background="base"
                      borderRadius="base"
                      border="base"
                    >
                      <s-stack direction="block" gap="base">
                        <s-stack
                          direction="inline"
                          gap="small"
                          alignItems="center"
                        >
                          <s-icon type="store" tone="neutral"></s-icon>
                          <s-text type="strong">{loaderData.shopName}</s-text>
                        </s-stack>

                        <s-box
                          padding="base"
                          background="subdued"
                          borderRadius="base"
                          border="base"
                        >
                          <s-stack
                            direction="inline"
                            gap="base"
                            alignItems="start"
                          >
                            <s-stack direction="block" gap="small">
                              <s-text type="strong">
                                Black Friday Giveaway
                              </s-text>
                              <s-paragraph>
                                {previewMessage ||
                                  "Your customer-facing message will appear here."}
                              </s-paragraph>
                            </s-stack>
                          </s-stack>
                        </s-box>
                      </s-stack>
                    </s-box>
                  </s-stack>
                </s-box>
                <s-paragraph color="subdued">
                  Preview only. Your Shopify checkout layout is not modified.
                </s-paragraph>
              </s-stack>
            </s-section>
          </s-grid>
        </s-query-container>
      </div>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}
export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
