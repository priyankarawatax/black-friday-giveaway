import type { LoaderFunctionArgs } from "react-router";

import prisma from "../db.server";
import { authenticate } from "../shopify.server";

const VALID_ENTRY_STATUSES = ["ELIGIBLE", "CONFIRMED"];

function orderIdCandidates(orderId: string) {
  const numeric = orderId.split("/").at(-1);
  return numeric && numeric !== orderId ? [orderId, numeric] : [orderId];
}

function customerIdCandidates(customerId: string) {
  const numeric = customerId.split("/").at(-1);
  return numeric && numeric !== customerId ? [customerId, numeric] : [customerId];
}

function ticketSort(left: string, right: string) {
  return left.localeCompare(right, undefined, { numeric: true });
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { sessionToken, cors } = await authenticate.public.checkout(request);
  const shop = new URL(sessionToken.dest).hostname;
  const customerId = sessionToken.sub;
  const orderId = new URL(request.url).searchParams.get("orderId")?.trim();

  if (!customerId || !orderId) {
    return cors(Response.json({ status: "pending" }));
  }

  const entry = await prisma.giveawayEntry.findFirst({
    where: {
      shop,
      shopifyOrderId: { in: orderIdCandidates(orderId) },
      shopifyCustomerId: { in: customerIdCandidates(customerId) },
      status: { in: VALID_ENTRY_STATUSES },
    },
    select: {
      orderDate: true,
      campaign: { select: { startDate: true, endDate: true } },
      tickets: {
        where: { status: "VALID" },
        select: { ticketNumber: true },
      },
    },
  });

  if (!entry) {
    return cors(Response.json({ status: "pending" }));
  }

  const applicable =
    entry.campaign.startDate &&
    entry.campaign.endDate &&
    entry.orderDate >= entry.campaign.startDate &&
    entry.orderDate <= entry.campaign.endDate;

  if (!applicable) {
    return cors(Response.json({ status: "not-applicable" }));
  }

  const tickets = entry.tickets
    .map(({ ticketNumber }) => ticketNumber)
    .sort(ticketSort);

  if (!tickets.length) {
    return cors(Response.json({ status: "pending" }));
  }

  const first = tickets[0];
  const last = tickets[tickets.length - 1];
  return cors(
    Response.json({
      status: "confirmed",
      ticketRange: first === last ? first : `${first}–${last}`,
      totalTickets: tickets.length,
    }),
  );
};
