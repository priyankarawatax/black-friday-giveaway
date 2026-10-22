import type { LoaderFunctionArgs } from "react-router";

import prisma from "../db.server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { sessionToken, cors } = await authenticate.public.checkout(request);
  const shop = new URL(sessionToken.dest).hostname;
  const customerId = sessionToken.sub;

  if (!customerId) {
    return cors(Response.json({ previousTickets: 0 }));
  }

  const campaign = await prisma.campaignSettings.findUnique({
    where: { shop },
    select: { id: true },
  });

  if (!campaign) {
    return cors(Response.json({ previousTickets: 0 }));
  }

  const numericCustomerId = customerId.split("/").at(-1);
  const customerIds = numericCustomerId
    ? [customerId, numericCustomerId]
    : [customerId];

  const previousTickets = await prisma.giveawayTicket.count({
    where: {
      shop,
      campaignId: campaign.id,
      status: "VALID",
      entry: {
        shopifyCustomerId: { in: customerIds },
        status: { in: ["ELIGIBLE", "CONFIRMED"] },
      },
    },
  });

  return cors(Response.json({ previousTickets }));
};
