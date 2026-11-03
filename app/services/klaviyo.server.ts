import type { KlaviyoEventOutbox, Prisma } from "@prisma/client";

import prisma from "../db.server";
import {
  DEFAULT_KLAVIYO_REVISION,
  resolveKlaviyoConfig,
  type ResolvedKlaviyoConfig,
} from "./klaviyo-config.server";

const KLAVIYO_EVENTS_ENDPOINT = "https://a.klaviyo.com/api/events";
const PROCESSING_TIMEOUT_MS = 10 * 60 * 1_000;
const MAX_DELIVERY_ATTEMPTS = 8;

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
  blocked: number;
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

async function sendEvent(
  event: KlaviyoEventOutbox,
  config: ResolvedKlaviyoConfig,
) {
  const payload = parsePayload(event.payload);
  if (!payload) {
    return {
      ok: false as const,
      retryable: false,
      error: "Invalid event payload.",
      orderId: "unknown",
    };
  }

  try {
    const response = await fetch(KLAVIYO_EVENTS_ENDPOINT, {
      method: "POST",
      headers: {
        Accept: "application/vnd.api+json",
        Authorization: `Klaviyo-API-Key ${config.apiKey}`,
        "Content-Type": "application/vnd.api+json",
        Revision:
          process.env.KLAVIYO_API_REVISION?.trim() || DEFAULT_KLAVIYO_REVISION,
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

    if (response.ok) return { ok: true as const, orderId: payload.orderId };

    return {
      ok: false as const,
      retryable: response.status === 429 || response.status >= 500,
      error: `Klaviyo returned status ${response.status}.`,
      orderId: payload.orderId,
    };
  } catch (error) {
    return {
      ok: false as const,
      retryable: true,
      error:
        error instanceof Error && error.name === "TimeoutError"
          ? "Klaviyo request timed out."
          : "Klaviyo request failed before a response was received.",
      orderId: payload.orderId,
    };
  }
}

export async function processKlaviyoOutbox(
  options: ProcessOptions = {},
): Promise<KlaviyoProcessResult> {
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
  let blocked = 0;
  const configByShop = new Map<string, Awaited<ReturnType<typeof resolveKlaviyoConfig>>>();

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
    let config = configByShop.get(candidate.shop);
    if (!config) {
      config = await resolveKlaviyoConfig(candidate.shop);
      configByShop.set(candidate.shop, config);
    }

    if (!config.enabled || !config.configured || !config.apiKey) {
      blocked += 1;
      const orderId = parsePayload(candidate.payload)?.orderId ?? "unknown";
      const reason = config.enabled
        ? config.error || `Klaviyo credentials are missing for ${candidate.shop}.`
        : `Klaviyo integration is disabled for ${candidate.shop}.`;
      await prisma.klaviyoEventOutbox.update({
        where: { id: candidate.id },
        data: {
          status: "BLOCKED",
          attempts: { increment: 1 },
          nextAttemptAt: null,
          lastError: reason.slice(0, 4_000),
        },
      });
      console.warn(
        `[Klaviyo] shop=${candidate.shop} order=${orderId} status=blocked reason=configuration`,
      );
      continue;
    }

    const result = await sendEvent(candidate, config);
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
      console.info(
        `[Klaviyo] shop=${candidate.shop} order=${result.orderId} status=sent`,
      );
      continue;
    }

    failed += 1;
    const canRetry = result.retryable && candidate.attempts + 1 < MAX_DELIVERY_ATTEMPTS;
    const nextAttemptAt = canRetry
      ? new Date(Date.now() + retryDelayMs(candidate.attempts))
      : null;
    await prisma.klaviyoEventOutbox.update({
      where: { id: candidate.id },
      data: {
        status: canRetry ? "FAILED" : "DEAD",
        attempts: { increment: 1 },
        nextAttemptAt,
        lastError: result.error.slice(0, 4_000),
      },
    });
    console.error(
      `[Klaviyo] shop=${candidate.shop} order=${result.orderId} status=${canRetry ? "retry_scheduled" : "failed"}`,
    );
  }

  return { configured: blocked === 0, processed, sent, failed, blocked };
}
