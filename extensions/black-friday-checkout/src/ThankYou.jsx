import "@shopify/ui-extensions/preact";
import { render } from "preact";

import {
  getTicketCountFromTotal,
  isFrenchLanguage,
  isCampaignActive,
  parseCampaignConfig,
  renderThankYouMessage,
} from "./campaign.js";

const CHECKOUT_METAFIELD_KEY = "black_friday_checkout_config";

export default function thankYouExtension() {
  render(<ThankYouBlock />, document.body);
}

function ThankYouBlock() {
  const entry = shopify.appMetafields.value.find(
    ({ metafield }) =>
      metafield.namespace === "$app" &&
      metafield.key === CHECKOUT_METAFIELD_KEY,
  );
  const config = parseCampaignConfig(entry?.metafield?.value);
  const orderId = shopify.orderConfirmation.value?.order?.id;
  const languageCode = shopify.localization.language.value?.isoCode;
  const french = isFrenchLanguage(languageCode);
  const configuredTemplate = french
    ? config?.thankYouMessages?.fr || config?.thankYouMessages?.en
    : config?.thankYouMessages?.en;
  const cartTotal = shopify.cost.totalAmount.value?.amount;
  const ticketCount = getTicketCountFromTotal(cartTotal);

  if (!isCampaignActive(config) || !orderId || !configuredTemplate) return null;

  const configuredLines = renderThankYouMessage(configuredTemplate, ticketCount)
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const heading = configuredLines[0];
  const bodyLines = configuredLines.slice(1);

  return (
    <s-banner heading={heading} tone="info">
      <s-stack direction="block" gap="small">
        {bodyLines.map((line) => (
          <s-text
            key={line}
            type={line.includes(String(ticketCount)) ? "strong" : undefined}
          >
            {line}
          </s-text>
        ))}
      </s-stack>
    </s-banner>
  );
}
