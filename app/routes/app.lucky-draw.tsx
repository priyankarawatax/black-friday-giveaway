import { useEffect, useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { Prisma } from "@prisma/client";

import prisma from "../db.server";
import styles from "../lucky-draw.module.css";
import {
  LuckyDrawError,
  selectLuckyWinner,
  winnerView,
} from "../services/lucky-draw.server";
import { authenticate } from "../shopify.server";

const ENTRY_STATUSES = ["ELIGIBLE", "CONFIRMED"];
const WHEEL_SEGMENTS = 12;
const COLORS = [
  "#6d28d9",
  "#2563eb",
  "#059669",
  "#ea580c",
  "#db2777",
  "#ca8a04",
  "#7c3aed",
  "#0284c7",
  "#16a34a",
  "#f97316",
  "#e11d48",
  "#a16207",
];

type DrawResult = Awaited<ReturnType<typeof selectLuckyWinner>>;
type ActionData =
  | { ok: true; winner: DrawResult; settingsSaved?: never }
  | { ok: true; settingsSaved: true; winner?: never }
  | { ok: true; winnerRemoved: true; winner?: never; settingsSaved?: never }
  | { ok: false; error: string; code: string };

function csvCell(value: unknown) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");
  if (intent === "remove-winner") {
    const winnerId = String(formData.get("winnerId") ?? "");
    if (!/^\d+$/.test(winnerId)) {
      return Response.json(
        { ok: false, error: "Invalid winner.", code: "INVALID_WINNER" },
        { status: 400 },
      );
    }
    const result = await prisma.giveawayWinner.updateMany({
      where: {
        id: BigInt(winnerId),
        shop: session.shop,
        status: "CONFIRMED",
      },
      data: { status: "REMOVED" },
    });
    if (!result.count) {
      return Response.json(
        {
          ok: false,
          error: "This winner was already removed or could not be found.",
          code: "WINNER_NOT_FOUND",
        },
        { status: 404 },
      );
    }
    return Response.json({ ok: true, winnerRemoved: true });
  }
  if (intent === "save-settings") {
    const maxWinners = Number(formData.get("maxWinners"));
    if (!Number.isInteger(maxWinners) || maxWinners < 1 || maxWinners > 100) {
      return Response.json(
        {
          ok: false,
          error: "Maximum winners must be between 1 and 100.",
          code: "INVALID_SETTINGS",
        },
        { status: 400 },
      );
    }
    const result = await prisma.campaignSettings.updateMany({
      where: { shop: session.shop },
      data: {
        maxWinners,
        preventRepeatWinner: formData.get("preventRepeatWinner") === "true",
        showWinnerRemoveAction:
          formData.get("showWinnerRemoveAction") === "true",
      },
    });
    if (!result.count) {
      return Response.json(
        {
          ok: false,
          error: "Save campaign settings before configuring the draw.",
          code: "CAMPAIGN_UNAVAILABLE",
        },
        { status: 404 },
      );
    }
    return Response.json({ ok: true, settingsSaved: true });
  }
  if (intent !== "draw") {
    return Response.json(
      { ok: false, error: "Unsupported action.", code: "INVALID_ACTION" },
      { status: 400 },
    );
  }

  try {
    const winner = await selectLuckyWinner({
      shop: session.shop,
      drawId: String(formData.get("drawId") ?? ""),
    });
    return Response.json({ ok: true, winner });
  } catch (error) {
    if (error instanceof LuckyDrawError) {
      const drawError = error as Error & { code: string };
      return Response.json(
        { ok: false, error: drawError.message, code: drawError.code },
        { status: 409 },
      );
    }
    console.error("Lucky draw failed", error);
    return Response.json(
      {
        ok: false,
        error: "The winner could not be selected. Please try again.",
        code: "DRAW_FAILED",
      },
      { status: 500 },
    );
  }
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const campaign = await prisma.campaignSettings.findUnique({
    where: { shop: session.shop },
    select: {
      id: true,
      campaignName: true,
      enabled: true,
      startDate: true,
      endDate: true,
      timezone: true,
      maxWinners: true,
      preventRepeatWinner: true,
      showWinnerRemoveAction: true,
    },
  });

  if (url.searchParams.get("export") === "winner") {
    const winnerId = url.searchParams.get("winnerId");
    if (!winnerId || !/^\d+$/.test(winnerId)) {
      throw new Response("Winner not found", { status: 404 });
    }
    const winner = await prisma.giveawayWinner.findFirst({
      where: { id: BigInt(winnerId), shop: session.shop },
      include: {
        campaign: { select: { campaignName: true } },
        ticket: { select: { ticketNumber: true } },
        entry: {
          select: {
            customerName: true,
            customerEmail: true,
            orderNumber: true,
          },
        },
      },
    });
    if (!winner) throw new Response("Winner not found", { status: 404 });
    const rows = [
      [
        "Winning ticket",
        "Customer name",
        "Customer email",
        "Order number",
        "Giveaway",
        "Draw date",
        "Status",
      ],
      [
        winner.ticket.ticketNumber,
        winner.entry.customerName,
        winner.entry.customerEmail,
        winner.entry.orderNumber,
        winner.campaign.campaignName,
        winner.drawnAt.toISOString(),
        winner.status,
      ],
    ];
    return new Response(
      rows.map((row) => row.map(csvCell).join(",")).join("\r\n"),
      {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="winner-${winner.ticket.ticketNumber}.csv"`,
        },
      },
    );
  }

  if (!campaign) {
    return {
      shop: session.shop,
      campaign: null,
      status: "Unavailable",
      ready: false,
      stats: { totalTickets: 0, eligibleCustomers: 0, winnersSelected: 0 },
      samples: [] as string[],
      currentWinner: null,
      recentWinners: [] as DrawResult[],
    };
  }

  const ticketWhere = {
    shop: session.shop,
    campaignId: campaign.id,
    status: "VALID",
    entry: { status: { in: ENTRY_STATUSES } },
  } satisfies Prisma.GiveawayTicketWhereInput;
  const [totalTickets, customerRows, winnersSelected, samples, winners] =
    await Promise.all([
      prisma.giveawayTicket.count({ where: ticketWhere }),
      prisma.giveawayEntry.groupBy({
        by: ["shopifyCustomerId"],
        where: {
          shop: session.shop,
          campaignId: campaign.id,
          status: { in: ENTRY_STATUSES },
          tickets: { some: { status: "VALID" } },
        },
      }),
      prisma.giveawayWinner.count({
        where: {
          shop: session.shop,
          campaignId: campaign.id,
          status: "CONFIRMED",
        },
      }),
      prisma.giveawayTicket.findMany({
        where: ticketWhere,
        orderBy: { id: "asc" },
        take: WHEEL_SEGMENTS,
        select: { ticketNumber: true },
      }),
      prisma.giveawayWinner.findMany({
        where: {
          shop: session.shop,
          campaignId: campaign.id,
          status: "CONFIRMED",
        },
        orderBy: { drawnAt: "desc" },
        take: 8,
        include: {
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
        },
      }),
    ]);
  const recentWinners = await Promise.all(winners.map(winnerView));
  const now = new Date();
  const status = !campaign.enabled
    ? "Disabled"
    : !campaign.startDate || !campaign.endDate
      ? "Unavailable"
      : now < campaign.startDate
        ? "Scheduled"
        : now > campaign.endDate
          ? "Ended"
          : "Active";
  const ready =
    campaign.enabled &&
    Boolean(campaign.startDate) &&
    now >= campaign.startDate! &&
    totalTickets > winnersSelected &&
    winnersSelected < campaign.maxWinners;

  return {
    shop: session.shop,
    campaign: {
      ...campaign,
      id: campaign.id.toString(),
      startDate: campaign.startDate?.toISOString() ?? null,
      endDate: campaign.endDate?.toISOString() ?? null,
    },
    status,
    ready,
    stats: {
      totalTickets,
      eligibleCustomers: customerRows.length,
      winnersSelected,
    },
    samples: samples.map(({ ticketNumber }) => ticketNumber),
    currentWinner: recentWinners[0] ?? null,
    recentWinners,
  };
};

function point(angle: number, radius: number) {
  const radians = ((angle - 90) * Math.PI) / 180;
  return {
    x: 250 + radius * Math.cos(radians),
    y: 250 + radius * Math.sin(radians),
  };
}

function segmentPath(index: number) {
  const start = point(index * 30, 220);
  const end = point((index + 1) * 30, 220);
  return `M 250 250 L ${start.x} ${start.y} A 220 220 0 0 1 ${end.x} ${end.y} Z`;
}

function customerAdminUrl(customerId: string) {
  const match = customerId.match(/Customer\/(\d+)$/);
  return match ? `shopify://admin/customers/${match[1]}` : null;
}

export default function LuckyDrawPage() {
  const data = useLoaderData<typeof loader>();
  const drawFetcher = useFetcher<ActionData>();
  const settingsFetcher = useFetcher<ActionData>();
  const removeFetcher = useFetcher<ActionData>();
  const [preventRepeatCustomer, setPreventRepeatCustomer] = useState(
    data.campaign?.preventRepeatWinner ?? false,
  );
  const [maxWinners, setMaxWinners] = useState(data.campaign?.maxWinners ?? 1);
  const [showWinnerRemoveAction, setShowWinnerRemoveAction] = useState(
    data.campaign?.showWinnerRemoveAction ?? true,
  );
  const [rotation, setRotation] = useState(() =>
    data.currentWinner ? 360 - data.currentWinner.visualIndex * 30 - 15 : 0,
  );
  const [spinning, setSpinning] = useState(false);
  const [celebrating, setCelebrating] = useState(false);
  const [winner, setWinner] = useState(data.currentWinner);
  const [visibleRecentWinners, setVisibleRecentWinners] = useState(
    data.recentWinners,
  );
  const [winnerToRemove, setWinnerToRemove] = useState<DrawResult | null>(null);
  const [showDrawFeedback, setShowDrawFeedback] = useState(false);
  const [showSettingsFeedback, setShowSettingsFeedback] = useState(false);
  const [showRemoveFeedback, setShowRemoveFeedback] = useState(false);
  const [showReadinessBanner, setShowReadinessBanner] = useState(!data.ready);
  const handledDraw = useRef<string | null>(null);

  useEffect(() => {
    if (!drawFetcher.data || drawFetcher.data.ok) {
      setShowDrawFeedback(false);
      return;
    }
    setShowDrawFeedback(true);
    const timeout = window.setTimeout(() => setShowDrawFeedback(false), 4000);
    return () => window.clearTimeout(timeout);
  }, [drawFetcher.data]);

  useEffect(() => {
    if (!settingsFetcher.data) return;
    setShowSettingsFeedback(true);
    const timeout = window.setTimeout(
      () => setShowSettingsFeedback(false),
      4000,
    );
    return () => window.clearTimeout(timeout);
  }, [settingsFetcher.data]);

  useEffect(() => {
    if (!removeFetcher.data) return;
    setShowRemoveFeedback(true);
    const timeout = window.setTimeout(() => setShowRemoveFeedback(false), 4000);
    return () => window.clearTimeout(timeout);
  }, [removeFetcher.data]);

  useEffect(() => {
    if (data.ready) {
      setShowReadinessBanner(false);
      return;
    }
    setShowReadinessBanner(true);
    const timeout = window.setTimeout(
      () => setShowReadinessBanner(false),
      4000,
    );
    return () => window.clearTimeout(timeout);
  }, [data.ready, data.stats.totalTickets, data.status]);

  useEffect(() => {
    if (
      !drawFetcher.data?.ok ||
      !drawFetcher.data.winner ||
      handledDraw.current === drawFetcher.data.winner.drawId
    )
      return;
    const selected = drawFetcher.data.winner;
    handledDraw.current = selected.drawId;
    setSpinning(true);
    setCelebrating(false);
    setRotation((current) => {
      const target = 360 - selected.visualIndex * 30 - 15;
      const normalized = ((current % 360) + 360) % 360;
      const advance = (target - normalized + 360) % 360;
      return current + 2160 + advance;
    });
    const reveal = window.setTimeout(() => {
      setWinner(selected);
      setVisibleRecentWinners((current) =>
        [selected, ...current.filter((item) => item.id !== selected.id)].slice(
          0,
          8,
        ),
      );
      setSpinning(false);
      setCelebrating(true);
    }, 6100);
    const stopCelebration = window.setTimeout(
      () => setCelebrating(false),
      8500,
    );
    return () => {
      window.clearTimeout(reveal);
      window.clearTimeout(stopCelebration);
    };
  }, [drawFetcher.data]);

  useEffect(() => {
    if (
      !removeFetcher.data?.ok ||
      !("winnerRemoved" in removeFetcher.data) ||
      !removeFetcher.data.winnerRemoved ||
      !winnerToRemove
    )
      return;
    if (winner?.id === winnerToRemove.id) {
      setWinner(
        visibleRecentWinners.find((item) => item.id !== winnerToRemove.id) ??
          null,
      );
    }
    setVisibleRecentWinners((current) =>
      current.filter((item) => item.id !== winnerToRemove.id),
    );
    setWinnerToRemove(null);
  }, [removeFetcher.data, visibleRecentWinners, winner, winnerToRemove]);

  const busy = drawFetcher.state !== "idle" || spinning;
  const canSpin =
    data.ready &&
    data.stats.totalTickets > data.stats.winnersSelected &&
    data.stats.winnersSelected < (data.campaign?.maxWinners ?? 0);
  const labels = Array.from(
    { length: WHEEL_SEGMENTS },
    (_, index) => data.samples[index] ?? "LUCKY",
  );
  if (winner) labels[winner.visualIndex] = winner.ticketNumber;

  function startDraw() {
    if (busy) return;
    const formData = new FormData();
    formData.set("intent", "draw");
    formData.set("drawId", crypto.randomUUID());
    drawFetcher.submit(formData, { method: "post" });
  }

  function openDrawConfirmation() {
    if (!canSpin || busy) return;
    const modal = document.getElementById("confirm-draw-modal") as
      (HTMLElement & { showOverlay?: () => void }) | null;
    modal?.showOverlay?.();
  }

  function saveSettings() {
    const formData = new FormData();
    formData.set("intent", "save-settings");
    formData.set("maxWinners", String(maxWinners));
    formData.set("preventRepeatWinner", String(preventRepeatCustomer));
    formData.set("showWinnerRemoveAction", String(showWinnerRemoveAction));
    settingsFetcher.submit(formData, { method: "post" });
  }

  function openRemoveWinner(item: DrawResult) {
    setWinnerToRemove(item);
    const modal = document.getElementById("remove-winner-modal") as
      (HTMLElement & { showOverlay?: () => void }) | null;
    modal?.showOverlay?.();
  }

  function removeWinner() {
    if (!winnerToRemove || removeFetcher.state !== "idle") return;
    const formData = new FormData();
    formData.set("intent", "remove-winner");
    formData.set("winnerId", winnerToRemove.id);
    removeFetcher.submit(formData, { method: "post" });
  }

  return (
    <s-page heading="Lucky Draw Wheel" inlineSize="large">
      <s-button
        slot="primary-action"
        icon="settings"
        commandFor="draw-settings-modal"
        command="--show"
      >
        Draw Settings
      </s-button>
      <s-modal id="draw-settings-modal" heading="Draw Settings" size="base">
        <s-stack direction="block" gap="base">
          <s-box padding="base" background="subdued" borderRadius="base">
            <s-stack direction="block" gap="small">
              <s-text type="strong">Giveaway selection</s-text>
              <s-text>
                {data.campaign?.campaignName ?? "No giveaway configured"}
              </s-text>
              <s-text color="subdued">
                {data.stats.totalTickets} eligible tickets · Status:{" "}
                {data.status}
              </s-text>
              {data.campaign?.startDate && data.campaign.endDate ? (
                <s-text color="subdued">
                  {new Date(data.campaign.startDate).toLocaleDateString()} –{" "}
                  {new Date(data.campaign.endDate).toLocaleDateString()}
                </s-text>
              ) : null}
            </s-stack>
          </s-box>
          <s-number-field
            label="Maximum winners"
            value={String(maxWinners)}
            min={1}
            max={100}
            step={1}
            onChange={(event) =>
              setMaxWinners(Number(event.currentTarget.value) || 1)
            }
          ></s-number-field>
          <s-checkbox
            label="Prevent the same customer from winning again"
            checked={preventRepeatCustomer}
            onChange={(event) =>
              setPreventRepeatCustomer(event.currentTarget.checked ?? false)
            }
          ></s-checkbox>
          <s-checkbox
            label="Show Remove action in Recent Winners"
            checked={showWinnerRemoveAction}
            onChange={(event) =>
              setShowWinnerRemoveAction(event.currentTarget.checked ?? false)
            }
          ></s-checkbox>
          <s-text color="subdued">
            Turn this off to hide the Remove button from merchants. Existing
            winner records will not be changed.
          </s-text>
          <s-banner tone="info">
            A winning ticket can never be selected more than once. Official
            results are saved permanently.
          </s-banner>
        </s-stack>
        <s-button
          slot="primary-action"
          variant="primary"
          commandFor="draw-settings-modal"
          command="--hide"
          loading={settingsFetcher.state !== "idle"}
          onClick={saveSettings}
        >
          Save settings
        </s-button>
      </s-modal>

      <s-modal id="confirm-draw-modal" heading="Start Lucky Draw?" size="small">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            You are about to randomly select a winner from all eligible tickets.
            Once confirmed, this result will be saved.
          </s-paragraph>
          <s-text color="subdued">
            Every eligible ticket has an equal chance. This result cannot be
            silently rerolled or replaced.
          </s-text>
        </s-stack>
        <s-button
          slot="primary-action"
          variant="primary"
          commandFor="confirm-draw-modal"
          command="--hide"
          disabled={busy}
          loading={busy}
          onClick={startDraw}
        >
          Confirm &amp; Spin
        </s-button>
        <s-button
          slot="secondary-actions"
          variant="secondary"
          commandFor="confirm-draw-modal"
          command="--hide"
        >
          Cancel
        </s-button>
      </s-modal>

      <s-modal id="remove-winner-modal" heading="Remove winner?" size="small">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Remove {winnerToRemove?.ticketNumber ?? "this winner"} from the
            confirmed winners list?
          </s-paragraph>
          <s-banner tone="warning">
            The official draw record will remain in the audit history as
            removed, and this ticket cannot win again.
          </s-banner>
        </s-stack>
        <s-button
          slot="primary-action"
          variant="primary"
          tone="critical"
          commandFor="remove-winner-modal"
          command="--hide"
          loading={removeFetcher.state !== "idle"}
          onClick={removeWinner}
        >
          Remove winner
        </s-button>
        <s-button
          slot="secondary-actions"
          variant="secondary"
          commandFor="remove-winner-modal"
          command="--hide"
        >
          Cancel
        </s-button>
      </s-modal>

      <s-stack direction="block" gap="base">
        <p className={styles.pageIntro}>
          Spin the wheel and randomly select a winner from your giveaway
          entries.
        </p>

        {showDrawFeedback && drawFetcher.data && !drawFetcher.data.ok ? (
          <s-banner tone="critical">{drawFetcher.data.error}</s-banner>
        ) : null}
        {showSettingsFeedback &&
        settingsFetcher.data &&
        !settingsFetcher.data.ok ? (
          <s-banner tone="critical">{settingsFetcher.data.error}</s-banner>
        ) : showSettingsFeedback &&
          settingsFetcher.data?.ok &&
          settingsFetcher.data.settingsSaved ? (
          <s-banner tone="success">Draw settings saved.</s-banner>
        ) : null}
        {showRemoveFeedback && removeFetcher.data && !removeFetcher.data.ok ? (
          <s-banner tone="critical">{removeFetcher.data.error}</s-banner>
        ) : showRemoveFeedback &&
          removeFetcher.data?.ok &&
          "winnerRemoved" in removeFetcher.data &&
          removeFetcher.data.winnerRemoved ? (
          <s-banner tone="success">
            Winner removed from the confirmed list.
          </s-banner>
        ) : null}
        {showReadinessBanner && !data.ready ? (
          <s-banner tone={data.stats.totalTickets ? "warning" : "info"}>
            {data.stats.totalTickets
              ? `The giveaway is ${data.status.toLowerCase()} and is not ready for a draw.`
              : "No eligible tickets are available. Sync paid orders before starting a draw."}
          </s-banner>
        ) : null}

        <s-grid
          gridTemplateColumns="repeat(auto-fit, minmax(190px, 1fr))"
          gap="base"
        >
          {[
            {
              label: "Total Tickets",
              value: data.stats.totalTickets,
              icon: "gift-card" as const,
              tone: styles.statTickets,
            },
            {
              label: "Eligible Customers",
              value: data.stats.eligibleCustomers,
              icon: "profile" as const,
              tone: styles.statCustomers,
            },
            {
              label: "Winners Selected",
              value: data.stats.winnersSelected,
              icon: "reward" as const,
              tone: styles.statWinners,
            },
          ].map((stat) => (
            <div className={`${styles.statCard} ${stat.tone}`} key={stat.label}>
              <s-stack direction="block" gap="small">
                <s-stack direction="inline" gap="small" alignItems="center">
                  <s-icon type={stat.icon}></s-icon>
                  <s-text type="strong">{stat.label}</s-text>
                </s-stack>
                <s-heading>{stat.value}</s-heading>
              </s-stack>
            </div>
          ))}
        </s-grid>

        <div className={styles.mainGrid}>
          <div className={styles.wheelCard}>
            {celebrating ? (
              <div className={styles.confetti} aria-hidden="true">
                {Array.from({ length: 28 }, (_, index) => (
                  <span
                    key={index}
                    className={styles.confettiPiece}
                    style={{
                      left: `${(index * 37) % 100}%`,
                      background: COLORS[index % COLORS.length],
                      animationDelay: `${(index % 7) * 0.08}s`,
                    }}
                  />
                ))}
              </div>
            ) : null}
            <s-heading>
              {spinning
                ? "Selecting your winner…"
                : "Ready for the official draw"}
            </s-heading>
            <div className={styles.wheelStage}>
              <div className={styles.pointer}></div>
              <svg
                className={styles.wheel}
                style={{ transform: `rotate(${rotation}deg)` }}
                viewBox="0 0 500 500"
                role="img"
                aria-label="Lucky draw wheel"
              >
                <circle className={styles.wheelRim} cx="250" cy="250" r="228" />
                {labels.map((label, index) => {
                  const labelPoint = point(index * 30 + 15, 155);
                  return (
                    <g key={`${index}-${label}`}>
                      <path
                        className={styles.segment}
                        d={segmentPath(index)}
                        fill={COLORS[index]}
                      />
                      <text
                        className={styles.segmentLabel}
                        x={labelPoint.x}
                        y={labelPoint.y}
                        transform={`rotate(${index * 30 + 15} ${labelPoint.x} ${labelPoint.y})`}
                      >
                        {label}
                      </text>
                    </g>
                  );
                })}
              </svg>
              <button
                type="button"
                className={styles.spinHubButton}
                onClick={openDrawConfirmation}
                disabled={!canSpin || busy}
                aria-label="Spin the wheel"
                aria-busy={busy}
              >
                SPIN
              </button>
            </div>
            <s-paragraph color="subdued">
              The wheel is visual only. Secure winner selection happens on the
              server.
            </s-paragraph>
          </div>

          <s-stack direction="block" gap="base">
            <div className={styles.winnerCard}>
              <s-box padding="base">
                <s-stack direction="block" gap="base">
                  <s-heading>Current Winner</s-heading>
                  {winner ? (
                    <>
                      <div className={styles.winnerHighlight}>
                        <s-text type="strong">Congratulations! 🎉</s-text>
                        <div className={styles.ticketNumber}>
                          {winner.ticketNumber}
                        </div>
                      </div>
                      <div className={styles.detailGrid}>
                        <div className={styles.detailItem}>
                          <s-text color="subdued">Customer</s-text>
                          <br />
                          <s-text type="strong">{winner.customerName}</s-text>
                        </div>
                        <div className={styles.detailItem}>
                          <s-text color="subdued">Order</s-text>
                          <br />
                          <s-text type="strong">{winner.orderNumber}</s-text>
                        </div>
                        <div className={styles.detailItem}>
                          <s-text color="subdued">Email</s-text>
                          <br />
                          <s-text>
                            {winner.customerEmail || "Not available"}
                          </s-text>
                        </div>
                        <div className={styles.detailItem}>
                          <s-text color="subdued">Customer tickets</s-text>
                          <br />
                          <s-text type="strong">{winner.totalTickets}</s-text>
                        </div>
                        <div className={styles.detailItem}>
                          <s-text color="subdued">Giveaway</s-text>
                          <br />
                          <s-text>{winner.campaignName}</s-text>
                        </div>
                        <div className={styles.detailItem}>
                          <s-text color="subdued">Draw date</s-text>
                          <br />
                          <s-text>
                            {new Date(winner.drawnAt).toLocaleString()}
                          </s-text>
                        </div>
                      </div>
                      <s-button-group>
                        <s-button
                          href={
                            customerAdminUrl(winner.customerId) ?? undefined
                          }
                          disabled={!customerAdminUrl(winner.customerId)}
                        >
                          View Customer
                        </s-button>
                        <s-button
                          icon="export"
                          href={`?export=winner&winnerId=${winner.id}`}
                        >
                          Export Result
                        </s-button>
                      </s-button-group>
                    </>
                  ) : (
                    <s-box
                      padding="large"
                      background="subdued"
                      borderRadius="base"
                    >
                      <s-stack
                        direction="block"
                        gap="small"
                        alignItems="center"
                      >
                        <s-icon type="gift-card" size="base"></s-icon>
                        <s-text type="strong">No winner selected yet</s-text>
                        <s-text color="subdued">
                          Spin the wheel to reveal your lucky winner!
                        </s-text>
                      </s-stack>
                    </s-box>
                  )}
                </s-stack>
              </s-box>
            </div>

            <s-section heading="Recent Winners" padding="none">
              {visibleRecentWinners.length ? (
                <s-table>
                  <s-table-header-row>
                    <s-table-header listSlot="primary">Ticket</s-table-header>
                    <s-table-header listSlot="labeled">Customer</s-table-header>
                    <s-table-header>Order</s-table-header>
                    <s-table-header>Draw date</s-table-header>
                    <s-table-header>Status</s-table-header>
                    {data.campaign?.showWinnerRemoveAction ? (
                      <s-table-header>Action</s-table-header>
                    ) : null}
                  </s-table-header-row>
                  <s-table-body>
                    {visibleRecentWinners.map((item) => (
                      <s-table-row key={item.id}>
                        <s-table-cell>
                          <s-text type="strong">{item.ticketNumber}</s-text>
                        </s-table-cell>
                        <s-table-cell>{item.customerName}</s-table-cell>
                        <s-table-cell>{item.orderNumber}</s-table-cell>
                        <s-table-cell>
                          {new Date(item.drawnAt).toLocaleDateString()}
                        </s-table-cell>
                        <s-table-cell>
                          <s-badge tone="success">{item.status}</s-badge>
                        </s-table-cell>
                        {data.campaign?.showWinnerRemoveAction ? (
                          <s-table-cell>
                            <s-button
                              tone="critical"
                              variant="tertiary"
                              icon="delete"
                              accessibilityLabel={`Remove winner ${item.ticketNumber}`}
                              onClick={() => openRemoveWinner(item)}
                            ></s-button>
                          </s-table-cell>
                        ) : null}
                      </s-table-row>
                    ))}
                  </s-table-body>
                </s-table>
              ) : (
                <s-box padding="large">
                  <s-stack direction="block" gap="small" alignItems="center">
                    <s-text type="strong">No winner history yet</s-text>
                    <s-text color="subdued">
                      Completed official draws will appear here.
                    </s-text>
                  </s-stack>
                </s-box>
              )}
            </s-section>
          </s-stack>
        </div>
      </s-stack>
    </s-page>
  );
}
