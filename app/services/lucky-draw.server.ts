import { randomInt } from "node:crypto";

import { Prisma } from "@prisma/client";

import prisma from "../db.server";

const ENTRY_STATUSES = ["ELIGIBLE", "CONFIRMED"];

export class LuckyDrawError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
  }
}

const winnerInclude = {
  campaign: { select: { campaignName: true } },
  ticket: { select: { ticketNumber: true } },
  entry: {
    select: {
      customerName: true,
      customerEmail: true,
      orderNumber: true,
      shopifyCustomerId: true,
      shopifyOrderId: true,
    },
  },
} satisfies Prisma.GiveawayWinnerInclude;

type WinnerWithDetails = Prisma.GiveawayWinnerGetPayload<{
  include: typeof winnerInclude;
}>;

export async function winnerView(winner: WinnerWithDetails) {
  const totalTickets = await prisma.giveawayTicket.count({
    where: {
      shop: winner.shop,
      campaignId: winner.campaignId,
      status: "VALID",
      entry: {
        shopifyCustomerId: winner.entry.shopifyCustomerId,
        status: { in: ENTRY_STATUSES },
      },
    },
  });

  return {
    id: winner.id.toString(),
    drawId: winner.drawId,
    ticketNumber: winner.ticket.ticketNumber,
    customerId: winner.entry.shopifyCustomerId,
    customerName: winner.entry.customerName,
    customerEmail: winner.entry.customerEmail,
    orderNumber: winner.entry.orderNumber,
    shopifyOrderId: winner.entry.shopifyOrderId,
    campaignName: winner.campaign.campaignName,
    totalTickets,
    status: winner.status,
    drawnAt: winner.drawnAt.toISOString(),
    visualIndex: Number(winner.ticketId % 12n),
  };
}

export async function selectLuckyWinner({
  shop,
  drawId,
}: {
  shop: string;
  drawId: string;
}) {
  if (!/^[a-zA-Z0-9-]{16,191}$/.test(drawId)) {
    throw new LuckyDrawError(
      "Invalid draw request. Please try again.",
      "INVALID_DRAW_ID",
    );
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const winner = await prisma.$transaction(
        async (tx) => {
          const existing = await tx.giveawayWinner.findUnique({
            where: { shop_drawId: { shop, drawId } },
            include: winnerInclude,
          });
          if (existing) return existing;

          const campaign = await tx.campaignSettings.findUnique({
            where: { shop },
            select: {
              id: true,
              enabled: true,
              startDate: true,
              endDate: true,
              maxWinners: true,
              preventRepeatWinner: true,
            },
          });
          if (!campaign?.enabled || !campaign.startDate || !campaign.endDate) {
            throw new LuckyDrawError(
              "The giveaway is disabled or has no valid schedule.",
              "CAMPAIGN_UNAVAILABLE",
            );
          }
          if (new Date() < campaign.startDate) {
            throw new LuckyDrawError(
              "The giveaway has not started yet.",
              "CAMPAIGN_SCHEDULED",
            );
          }

          await tx.$queryRaw(Prisma.sql`
            SELECT id FROM CampaignSettings
            WHERE id = ${campaign.id} AND shop = ${shop}
            FOR UPDATE
          `);

          const completedDraws = await tx.giveawayWinner.count({
            where: {
              shop,
              campaignId: campaign.id,
              status: "CONFIRMED",
            },
          });
          if (completedDraws >= campaign.maxWinners) {
            throw new LuckyDrawError(
              `This giveaway has already selected its maximum of ${campaign.maxWinners} winner${campaign.maxWinners === 1 ? "" : "s"}.`,
              "WINNER_LIMIT_REACHED",
            );
          }

          const previousCustomerIds = campaign.preventRepeatWinner
            ? (
                await tx.giveawayWinner.findMany({
                  where: { shop, campaignId: campaign.id, status: "CONFIRMED" },
                  select: { customerId: true },
                  distinct: ["customerId"],
                })
              ).map(({ customerId }) => customerId)
            : [];

          const ticketWhere: Prisma.GiveawayTicketWhereInput = {
            shop,
            campaignId: campaign.id,
            status: "VALID",
            winners: { none: {} },
            entry: {
              shop,
              status: { in: ENTRY_STATUSES },
              ...(previousCustomerIds.length
                ? { shopifyCustomerId: { notIn: previousCustomerIds } }
                : {}),
            },
          };
          const eligibleCount = await tx.giveawayTicket.count({
            where: ticketWhere,
          });
          if (eligibleCount < 1) {
            throw new LuckyDrawError(
              campaign.preventRepeatWinner
                ? "No eligible tickets remain after excluding previous winners."
                : "No eligible tickets are available for this draw.",
              "NO_ELIGIBLE_TICKETS",
            );
          }

          const offset = randomInt(eligibleCount);
          const winningTicket = await tx.giveawayTicket.findFirst({
            where: ticketWhere,
            orderBy: { id: "asc" },
            skip: offset,
            select: { id: true, entryId: true, entry: true },
          });
          if (!winningTicket) {
            throw new LuckyDrawError(
              "The eligible ticket set changed. Please try again.",
              "TICKET_SET_CHANGED",
            );
          }

          return tx.giveawayWinner.create({
            data: {
              shop,
              campaignId: campaign.id,
              ticketId: winningTicket.id,
              entryId: winningTicket.entryId,
              customerId: winningTicket.entry.shopifyCustomerId,
              shopifyOrderId: winningTicket.entry.shopifyOrderId,
              drawId,
              status: "CONFIRMED",
            },
            include: winnerInclude,
          });
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          timeout: 30_000,
        },
      );

      return winnerView(winner);
    } catch (error) {
      if (error instanceof LuckyDrawError) throw error;
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        (error.code === "P2002" || error.code === "P2034") &&
        attempt < 2
      ) {
        continue;
      }
      throw error;
    }
  }

  throw new LuckyDrawError(
    "Another draw is in progress. Please try again.",
    "DRAW_CONFLICT",
  );
}
