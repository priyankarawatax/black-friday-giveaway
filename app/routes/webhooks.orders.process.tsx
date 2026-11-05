import type { ActionFunctionArgs } from "react-router";

import { orderFromWebhook, persistGiveawayOrder } from "../services/giveaway-order.server";
import { processKlaviyoOutbox } from "../services/klaviyo.server";
import { authenticate } from "../shopify.server";

function dispatchPendingKlaviyoEvents(
  shop: string,
  orderId: string,
  uniqueId: string,
) {
  void processKlaviyoOutbox({ limit: 1, uniqueId })
    .then((result) => {
      console.log(
        `[Klaviyo] shop=${shop} order=${orderId} processed=${result.processed} sent=${result.sent} failed=${result.failed} blocked=${result.blocked}`,
      );
    })
    .catch(() => {
      console.error(
        `[Klaviyo] shop=${shop} order=${orderId} status=processor_error`,
      );
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
    `Processed ${topic} for ${shop}, order ${order.number}: ${result.status}${result.status === "ineligible" ? ` (${result.reason})` : ""}`,
  );

  if (result.status !== "ineligible" && result.klaviyoEventUniqueId) {
    dispatchPendingKlaviyoEvents(shop, order.id, result.klaviyoEventUniqueId);
  }

  return new Response();
};
