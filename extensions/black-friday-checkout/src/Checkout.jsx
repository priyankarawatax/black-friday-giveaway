import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";

import {
  getCheckoutMessages,
  getTicketCountFromTotal,
  getTicketSummary,
  isCampaignActive,
  parseCampaignConfig,
  renderTicketMessage,
} from "./campaign.js";

const CHECKOUT_METAFIELD_KEY = "black_friday_checkout_config";

export default function checkoutExtension() {
  render(<Extension />, document.body);
}

function Extension() {
  const entry = shopify.appMetafields.value.find(
    ({ metafield }) =>
      metafield.namespace === "$app" &&
      metafield.key === CHECKOUT_METAFIELD_KEY,
  );
  const config = parseCampaignConfig(entry?.metafield?.value);
  const campaignActive = isCampaignActive(config, Date.now());
  const languageCode = shopify.localization.language.value?.isoCode;
  const checkoutMessages = getCheckoutMessages(config, languageCode);
  const previousTickets = usePreviousTicketCount(
    campaignActive ? config?.ticketTotalUrl : null,
  );

  if (!campaignActive) return null;

  const orderTickets = getTicketCountFromTotal(
    shopify.cost.totalAmount.value?.amount,
  );
  const ticketSummary = getTicketSummary(orderTickets, previousTickets);
  const entryMessage =
    checkoutMessages.entry || shopify.i18n.translate("entryConfirmation");
  const ticketMessage = checkoutMessages.tickets
    ? renderTicketMessage(
        checkoutMessages.tickets,
        ticketSummary.orderTickets,
        ticketSummary.totalTickets,
      )
    : shopify.i18n.translate("ticketSummary", ticketSummary);
  const motivationMessage =
    checkoutMessages.motivation ||
    shopify.i18n.translate("motivationalMessage");

  return (
    <s-box
      background="subdued"
      border="base"
      borderRadius="base"
      padding="small"
      accessibilityLabel={entryMessage}
    >
      <s-stack direction="block" gap="none">
        <s-text>{entryMessage}</s-text>
        <s-text type="strong">{ticketMessage}</s-text>
        <s-text color="subdued">{motivationMessage}</s-text>
      </s-stack>
    </s-box>
  );
}

function usePreviousTicketCount(ticketTotalUrl) {
  const [previousTickets, setPreviousTickets] = useState(0);

  useEffect(() => {
    if (!ticketTotalUrl) return;

    const controller = new AbortController();

    async function loadPreviousTickets() {
      try {
        const token = await shopify.sessionToken.get();
        const response = await fetch(ticketTotalUrl, {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
        if (!response.ok) return;

        const result = await response.json();
        setPreviousTickets(Math.max(0, Number(result.previousTickets) || 0));
      } catch (error) {
        if (error?.name !== "AbortError") setPreviousTickets(0);
      }
    }

    loadPreviousTickets();
    return () => controller.abort();
  }, [ticketTotalUrl]);

  return previousTickets;
}
