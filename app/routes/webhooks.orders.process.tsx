import type { ActionFunctionArgs } from "react-router";

import { orderFromWebhook, persistGiveawayOrder } from "../services/giveaway-order.server";
import { authenticate } from "../shopify.server";

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

  return new Response();
};
