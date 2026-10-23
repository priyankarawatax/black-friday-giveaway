import type { KlaviyoEventOutbox, Prisma } from "@prisma/client";

import prisma from "../db.server";

const KLAVIYO_EVENTS_ENDPOINT = "https://a.klaviyo.com/api/events";
const DEFAULT_REVISION = "2026-04-15";
const PROCESSING_TIMEOUT_MS = 10 * 60 * 1_000;

type GiveawayKlaviyoPayload = {
  email: string;
  customerName: string;
  orderNumber: string;
  orderId: string;
  orderDate: string;
  campaignName: string;
  ticketsEarned: number;
  totalTickets: number;
  firstTicket: string;
  lastTicket: string;
  ticketRange: string;
};

type ProcessOptions = {
  limit?: number;
  uniqueId?: string;
};

export type KlaviyoProcessResult = {
  configured: boolean;
  processed: number;
  sent: number;
  failed: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePayload(value: Prisma.JsonValue): GiveawayKlaviyoPayload | null {
  if (!isRecord(value)) return null;

  const requiredStrings = [
    "email",
    "customerName",
    "orderNumber",
    "orderId",
    "orderDate",
    "campaignName",
    "firstTicket",
    "lastTicket",
    "ticketRange",
  ] as const;
  if (requiredStrings.some((key) => typeof value[key] !== "string")) return null;
  if (
    typeof value.ticketsEarned !== "number" ||
    typeof value.totalTickets !== "number"
  ) {
    return null;
  }

  return value as GiveawayKlaviyoPayload;
}

function retryDelayMs(attempt: number) {
  return Math.min(60 * 60 * 1_000, 30_000 * 2 ** Math.min(attempt, 7));
}

async function sendEvent(event: KlaviyoEventOutbox) {
  const apiKey = process.env.KLAVIYO_PRIVATE_API_KEY?.trim();
  if (!apiKey) throw new Error("Klaviyo is not configured.");

  const payload = parsePayload(event.payload);
  if (!payload) {
    return { ok: false as const, retryable: false, error: "Invalid event payload." };
  }

  try {
    const response = await fetch(KLAVIYO_EVENTS_ENDPOINT, {
      method: "POST",
      headers: {
        Accept: "application/vnd.api+json",
        Authorization: `Klaviyo-API-Key ${apiKey}`,
        "Content-Type": "application/vnd.api+json",
        Revision: process.env.KLAVIYO_API_REVISION?.trim() || DEFAULT_REVISION,
      },
      body: JSON.stringify({
        data: {
          type: "event",
          attributes: {
            properties: {
              order_number: payload.orderNumber,
              order_id: payload.orderId,
              campaign_name: payload.campaignName,
              customer_name: payload.customerName,
              tickets_earned: payload.ticketsEarned,
              total_tickets: payload.totalTickets,
              first_ticket: payload.firstTicket,
              last_ticket: payload.lastTicket,
              ticket_range: payload.ticketRange,
            },
            time: payload.orderDate,
            unique_id: event.uniqueId,
            metric: {
              data: {
                type: "metric",
                attributes: { name: event.metricName },
              },
            },
            profile: {
              data: {
                type: "profile",
                attributes: { email: payload.email },
              },
            },
          },
        },
      }),
      signal: AbortSignal.timeout(8_000),
    });

    if (response.ok) return { ok: true as const };

    const responseText = (await response.text()).slice(0, 1_500);
    return {
      ok: false as const,
      retryable: response.status === 429 || response.status >= 500,
      error: `Klaviyo returned ${response.status}: ${responseText}`,
    };
  } catch (error) {
    return {
      ok: false as const,
      retryable: true,
      error: error instanceof Error ? error.message : "Unknown Klaviyo request error.",
    };
  }
}

export async function processKlaviyoOutbox(
  options: ProcessOptions = {},
): Promise<KlaviyoProcessResult> {
  if (!process.env.KLAVIYO_PRIVATE_API_KEY?.trim()) {
    return { configured: false, processed: 0, sent: 0, failed: 0 };
  }

  const now = new Date();
  const staleBefore = new Date(now.getTime() - PROCESSING_TIMEOUT_MS);
  const limit = Math.max(1, Math.min(options.limit ?? 25, 100));
  const candidates = await prisma.klaviyoEventOutbox.findMany({
    where: {
      ...(options.uniqueId ? { uniqueId: options.uniqueId } : {}),
      OR: [
        { status: "PENDING" },
        { status: "FAILED", nextAttemptAt: { lte: now } },
        { status: "PROCESSING", updatedAt: { lte: staleBefore } },
      ],
    },
    orderBy: { createdAt: "asc" },
    take: limit,
  });

  let processed = 0;
  let sent = 0;
  let failed = 0;

  for (const candidate of candidates) {
    const claimed = await prisma.klaviyoEventOutbox.updateMany({
      where: {
        id: candidate.id,
        status: candidate.status,
        updatedAt: candidate.updatedAt,
      },
      data: { status: "PROCESSING", lastError: null },
    });
    if (claimed.count !== 1) continue;

    processed += 1;
    const result = await sendEvent(candidate);
    if (result.ok) {
      sent += 1;
      await prisma.klaviyoEventOutbox.update({
        where: { id: candidate.id },
        data: {
          status: "SENT",
          attempts: { increment: 1 },
          sentAt: new Date(),
          nextAttemptAt: null,
          lastError: null,
        },
      });
      continue;
    }

    failed += 1;
    const nextAttemptAt = result.retryable
      ? new Date(Date.now() + retryDelayMs(candidate.attempts))
      : null;
    await prisma.klaviyoEventOutbox.update({
      where: { id: candidate.id },
      data: {
        status: result.retryable ? "FAILED" : "DEAD",
        attempts: { increment: 1 },
        nextAttemptAt,
        lastError: result.error.slice(0, 4_000),
      },
    });
  }

  return { configured: true, processed, sent, failed };
}
