import type { ActionFunctionArgs } from "react-router";

import { orderFromWebhook, persistGiveawayOrder } from "../services/giveaway-order.server";
import { processKlaviyoOutbox } from "../services/klaviyo.server";
import { authenticate } from "../shopify.server";

function dispatchPendingKlaviyoEvents() {
  void processKlaviyoOutbox({ limit: 25 })
    .then((result) => {
      console.log(
        `Klaviyo outbox processed: ${result.processed}, sent: ${result.sent}, failed: ${result.failed}`,
      );
    })
    .catch((error: unknown) => {
      console.error("Failed to process the Klaviyo outbox.", error);
    });
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, shop, topic } = await authenticate.webhook(request);
  const financialStatus = (payload as { financial_status?: string }).financial_status;

  if (financialStatus && financialStatus !== "paid") {
    console.log(`Ignored unpaid ${topic} order for ${shop}.`);
    return new Response();
  }

  const order = orderFromWebhook(payload);

  if (!order) {
    console.error(`Ignored invalid ${topic} payload for ${shop}.`);
    return new Response();
  }

  const result = await persistGiveawayOrder(shop, order, {
    queueKlaviyoEvent: true,
  });
  console.log(
    `Processed ${topic} for ${shop}, order ${order.number}: ${result.status}`,
  );

  if (result.status !== "ineligible" && result.klaviyoEventUniqueId) {
    dispatchPendingKlaviyoEvents();
  }

  return new Response();
};
