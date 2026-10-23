import { Prisma } from "@prisma/client";

import prisma from "../db.server";

const TICKET_BATCH_SIZE = 1_000;
const TICKET_PREFIX = "UVT-";
const FIRST_TICKET_SEQUENCE = 100_000;

export function formatTicketNumber(sequence: number) {
  return `${TICKET_PREFIX}${String(sequence).padStart(6, "0")}`;
}

export type GiveawayOrder = {
  id: string;
  number: string;
  processedAt: Date;
  customerId: string;
  customerName: string;
  customerEmail: string;
  totalAmount: string;
  currencyCode: string;
};

export type GiveawayOrderResult =
  | { status: "created"; tickets: number; klaviyoEventUniqueId: string | null }
  | { status: "duplicate"; tickets: number; klaviyoEventUniqueId: string | null }
  | { status: "ineligible"; reason: string };

type PersistGiveawayOrderOptions = {
  queueKlaviyoEvent?: boolean;
};

type ShopifyOrderWebhookPayload = {
  id?: string | number;
  admin_graphql_api_id?: string;
  name?: string;
  order_number?: string | number;
  processed_at?: string;
  created_at?: string;
  contact_email?: string;
  email?: string;
  current_total_price?: string;
  total_price?: string;
  currency?: string;
  customer?: {
    id?: string | number;
    admin_graphql_api_id?: string;
    first_name?: string;
    last_name?: string;
    email?: string;
  } | null;
  billing_address?: { name?: string } | null;
  shipping_address?: { name?: string } | null;
};

export type ShopifyOrderGraphqlNode = {
  id: string;
  name: string;
  processedAt: string;
  createdAt: string;
  email?: string | null;
  customer?: {
    id: string;
    displayName: string;
    defaultEmailAddress?: { emailAddress: string } | null;
  } | null;
  currentTotalPriceSet: {
    shopMoney: { amount: string; currencyCode: string };
  };
};

function clean(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export function orderFromWebhook(payload: unknown): GiveawayOrder | null {
  const order = payload as ShopifyOrderWebhookPayload;
  const id = clean(order.admin_graphql_api_id) || String(order.id ?? "");
  const processedAt = new Date(order.processed_at ?? order.created_at ?? "");
  const email = clean(order.contact_email) || clean(order.email) || clean(order.customer?.email);
  const customerName =
    [clean(order.customer?.first_name), clean(order.customer?.last_name)]
      .filter(Boolean)
      .join(" ") ||
    clean(order.billing_address?.name) ||
    clean(order.shipping_address?.name) ||
    email ||
    "Guest customer";
  const customerId =
    clean(order.customer?.admin_graphql_api_id) ||
    (order.customer?.id ? String(order.customer.id) : "") ||
    (email ? `guest:${email.toLowerCase()}` : `order:${id}`);

  if (!id || Number.isNaN(processedAt.getTime())) return null;

  return {
    id,
    number: clean(order.name) || String(order.order_number ?? id),
    processedAt,
    customerId,
    customerName,
    customerEmail: email,
    totalAmount: clean(order.current_total_price) || clean(order.total_price) || "0",
    currencyCode: clean(order.currency).toUpperCase() || "USD",
  };
}

export function orderFromGraphql(order: ShopifyOrderGraphqlNode): GiveawayOrder | null {
  const processedAt = new Date(order.processedAt || order.createdAt);
  const email =
    clean(order.email) || clean(order.customer?.defaultEmailAddress?.emailAddress);
  if (!order.id || Number.isNaN(processedAt.getTime())) return null;

  return {
    id: order.id,
    number: clean(order.name) || order.id,
    processedAt,
    customerId:
      clean(order.customer?.id) ||
      (email ? `guest:${email.toLowerCase()}` : `order:${order.id}`),
    customerName: clean(order.customer?.displayName) || email || "Guest customer",
    customerEmail: email,
    totalAmount: order.currentTotalPriceSet.shopMoney.amount,
    currencyCode: order.currentTotalPriceSet.shopMoney.currencyCode,
  };
}

export async function persistGiveawayOrder(
  shop: string,
  order: GiveawayOrder,
  options: PersistGiveawayOrderOptions = {},
): Promise<GiveawayOrderResult> {
  const campaign = await prisma.campaignSettings.findUnique({
    where: { shop },
    select: {
      id: true,
      campaignName: true,
      enabled: true,
      startDate: true,
      endDate: true,
    },
  });

  if (!campaign?.enabled || !campaign.startDate || !campaign.endDate) {
    return { status: "ineligible", reason: "Campaign is not enabled or scheduled." };
  }
  if (order.processedAt < campaign.startDate || order.processedAt > campaign.endDate) {
    return { status: "ineligible", reason: "Order is outside the campaign dates." };
  }

  const numericAmount = Number(order.totalAmount);
  const ticketCount = Number.isFinite(numericAmount) && numericAmount > 0
    ? Math.floor(numericAmount)
    : 0;
  if (ticketCount < 1) {
    return { status: "ineligible", reason: "Order total does not earn a ticket." };
  }

  return prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw(Prisma.sql`
        SELECT id FROM CampaignSettings
        WHERE id = ${campaign.id} AND shop = ${shop}
        FOR UPDATE
      `);

      const existing = await tx.giveawayEntry.findUnique({
        where: { shop_shopifyOrderId: { shop, shopifyOrderId: order.id } },
        select: {
          id: true,
          _count: { select: { tickets: true } },
          klaviyoEvents: { select: { uniqueId: true }, take: 1 },
        },
      });
      if (existing) {
        return {
          status: "duplicate",
          tickets: existing._count.tickets,
          klaviyoEventUniqueId: existing.klaviyoEvents[0]?.uniqueId ?? null,
        } as const;
      }

      const [lastTicket] = await tx.$queryRaw<Array<{ ticketNumber: bigint | number | null }>>(
        Prisma.sql`
          SELECT MAX(
            CAST(SUBSTRING_INDEX(ticketNumber, '-', -1) AS UNSIGNED)
          ) AS ticketNumber
          FROM GiveawayTicket
          WHERE campaignId = ${campaign.id}
            AND ticketNumber REGEXP '^(UVT-)?[0-9]+$'
        `,
      );
      const firstTicket = Math.max(
        FIRST_TICKET_SEQUENCE,
        Number(lastTicket?.ticketNumber ?? 0) + 1,
      );
      const entry = await tx.giveawayEntry.create({
        data: {
          shop,
          campaignId: campaign.id,
          shopifyCustomerId: order.customerId,
          customerName: order.customerName,
          customerEmail: order.customerEmail,
          shopifyOrderId: order.id,
          orderNumber: order.number,
          orderDate: order.processedAt,
          eligibleAmount: new Prisma.Decimal(order.totalAmount),
          currencyCode: order.currencyCode.slice(0, 3),
          status: "CONFIRMED",
        },
      });

      for (let offset = 0; offset < ticketCount; offset += TICKET_BATCH_SIZE) {
        const size = Math.min(TICKET_BATCH_SIZE, ticketCount - offset);
        await tx.giveawayTicket.createMany({
          data: Array.from({ length: size }, (_, index) => ({
            shop,
            campaignId: campaign.id,
            entryId: entry.id,
            ticketNumber: formatTicketNumber(firstTicket + offset + index),
            status: "VALID",
          })),
        });
      }

      let klaviyoEventUniqueId: string | null = null;
      if (options.queueKlaviyoEvent && order.customerEmail) {
        const totalTickets = await tx.giveawayTicket.count({
          where: {
            shop,
            campaignId: campaign.id,
            status: "VALID",
            entry: { shopifyCustomerId: order.customerId },
          },
        });
        const firstTicketNumber = formatTicketNumber(firstTicket);
        const lastTicketNumber = formatTicketNumber(firstTicket + ticketCount - 1);
        klaviyoEventUniqueId = `giveaway:${campaign.id.toString()}:${order.id}`;

        await tx.klaviyoEventOutbox.create({
          data: {
            shop,
            campaignId: campaign.id,
            entryId: entry.id,
            uniqueId: klaviyoEventUniqueId,
            metricName: "Giveaway Tickets Confirmed",
            payload: {
              email: order.customerEmail,
              customerName: order.customerName,
              orderNumber: order.number,
              orderId: order.id,
              orderDate: order.processedAt.toISOString(),
              campaignName: campaign.campaignName,
              ticketsEarned: ticketCount,
              totalTickets,
              firstTicket: firstTicketNumber,
              lastTicket: lastTicketNumber,
              ticketRange: `${firstTicketNumber} - ${lastTicketNumber}`,
            },
          },
        });
      }

      return {
        status: "created",
        tickets: ticketCount,
        klaviyoEventUniqueId,
      } as const;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 },
  );
}
