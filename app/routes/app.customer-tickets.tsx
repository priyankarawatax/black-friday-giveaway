import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useNavigate } from "react-router";
import { Prisma } from "@prisma/client";

import prisma from "../db.server";
import {
  orderFromGraphql,
  persistGiveawayOrder,
  type ShopifyOrderGraphqlNode,
} from "../services/giveaway-order.server";
import { authenticate } from "../shopify.server";
import styles from "../customer-tickets.module.css";

const PAGE_SIZE = 25;
const TICKET_PAGE_SIZE = 100;
const VALID_ENTRY_STATUSES = ["ELIGIBLE", "CONFIRMED"];

type CustomerRow = {
  customerId: string;
  customerName: string;
  customerEmail: string;
  eligibleOrders: bigint | number;
  totalSpent: Prisma.Decimal | number;
  currencyCode: string;
  ticketCount: bigint | number;
  ticketNumbers: string | null;
  lastPurchase: Date;
};

type CountRow = { total: bigint | number };
type SummaryRow = {
  totalTickets: bigint | number;
  uniqueCustomers: bigint | number;
  eligibleOrders: bigint | number;
};
type SyncActionData =
  | { ok: true; created: number; duplicates: number; skipped: number }
  | { ok: false; error: string };

function positiveInteger(value: string | null, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function csvCell(value: unknown) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function customerInitials(name: string) {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") || "?"
  );
}

function pageHref(url: URL, page: number) {
  const params = new URLSearchParams(url.searchParams);
  params.set("page", String(page));
  params.delete("customer");
  params.delete("ticketPage");
  return `?${params.toString()}`;
}

type OrdersResponse = {
  data?: {
    orders: {
      nodes: ShopifyOrderGraphqlNode[];
      pageInfo: { hasNextPage: boolean; endCursor?: string | null };
    };
  };
  errors?: Array<{ message: string }>;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const campaign = await prisma.campaignSettings.findUnique({
    where: { shop: session.shop },
    select: { startDate: true, endDate: true },
  });

  if (!campaign?.startDate || !campaign.endDate) {
    return Response.json(
      { ok: false, error: "Save campaign dates before syncing orders." },
      { status: 400 },
    );
  }

  const search = [
    "financial_status:paid",
    `created_at:>=${campaign.startDate.toISOString()}`,
    `created_at:<=${campaign.endDate.toISOString()}`,
  ].join(" ");
  let cursor: string | null = null;
  let created = 0;
  let duplicates = 0;
  let skipped = 0;

  do {
    const response = await admin.graphql(
      `#graphql
        query GiveawayPaidOrders($cursor: String, $query: String!) {
          orders(first: 100, after: $cursor, query: $query, sortKey: CREATED_AT) {
            nodes {
              id
              name
              processedAt
              createdAt
              email
              customer { id displayName defaultEmailAddress { emailAddress } }
              currentSubtotalPriceSet { shopMoney { amount currencyCode } }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      `,
      { variables: { cursor, query: search } },
    );
    const payload = (await response.json()) as OrdersResponse;
    if (payload.errors?.length || !payload.data) {
      throw new Error(
        payload.errors?.map(({ message }) => message).join("; ") ||
          "Order sync failed.",
      );
    }

    for (const node of payload.data.orders.nodes) {
      const order = orderFromGraphql(node);
      if (!order) {
        skipped += 1;
        continue;
      }
      const result = await persistGiveawayOrder(session.shop, order);
      if (result.status === "created") created += 1;
      else if (result.status === "duplicate") duplicates += 1;
      else skipped += 1;
    }

    cursor = payload.data.orders.pageInfo.endCursor ?? null;
    if (!payload.data.orders.pageInfo.hasNextPage) cursor = null;
  } while (cursor);

  return Response.json({ ok: true, created, duplicates, skipped });
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const campaign = await prisma.campaignSettings.findUnique({
    where: { shop: session.shop },
    select: { id: true },
  });

  const filters = {
    q: (url.searchParams.get("q") ?? "").trim(),
    dateFrom: url.searchParams.get("dateFrom") ?? "",
    dateTo: url.searchParams.get("dateTo") ?? "",
    minTickets: url.searchParams.get("minTickets") ?? "",
    status: url.searchParams.get("status") ?? "all",
    sort: url.searchParams.get("sort") ?? "tickets-desc",
  };
  const page = positiveInteger(url.searchParams.get("page"), 1);

  if (!campaign) {
    return {
      filters,
      page,
      totalPages: 1,
      summary: { totalTickets: 0, uniqueCustomers: 0, eligibleOrders: 0 },
      customers: [],
      selectedCustomer: null,
    };
  }

  const conditions: Prisma.Sql[] = [
    Prisma.sql`e.shop = ${session.shop}`,
    Prisma.sql`e.campaignId = ${campaign.id}`,
    Prisma.sql`e.status IN (${Prisma.join(VALID_ENTRY_STATUSES)})`,
  ];

  if (
    filters.status !== "all" &&
    VALID_ENTRY_STATUSES.includes(filters.status)
  ) {
    conditions.push(Prisma.sql`e.status = ${filters.status}`);
  }
  if (filters.dateFrom) {
    const date = new Date(`${filters.dateFrom}T00:00:00.000Z`);
    if (!Number.isNaN(date.getTime()))
      conditions.push(Prisma.sql`e.orderDate >= ${date}`);
  }
  if (filters.dateTo) {
    const date = new Date(`${filters.dateTo}T23:59:59.999Z`);
    if (!Number.isNaN(date.getTime()))
      conditions.push(Prisma.sql`e.orderDate <= ${date}`);
  }
  if (filters.q) {
    const contains = `%${filters.q}%`;
    conditions.push(
      Prisma.sql`(
        e.customerName LIKE ${contains}
        OR e.customerEmail LIKE ${contains}
        OR EXISTS (
          SELECT 1 FROM GiveawayTicket search_ticket
          WHERE search_ticket.entryId = e.id
            AND search_ticket.shop = ${session.shop}
            AND search_ticket.ticketNumber = ${filters.q}
        )
      )`,
    );
  }

  const whereSql = Prisma.join(conditions, " AND ");
  const minTickets = Math.max(0, Number(filters.minTickets) || 0);
  const havingSql = Prisma.sql`tr.ticketCount >= ${minTickets}`;
  const orderSql =
    filters.sort === "tickets-asc"
      ? Prisma.sql`tr.ticketCount ASC, er.customerName ASC`
      : filters.sort === "newest"
        ? Prisma.sql`er.lastPurchase DESC`
        : filters.sort === "oldest"
          ? Prisma.sql`er.lastPurchase ASC`
          : Prisma.sql`tr.ticketCount DESC, er.customerName ASC`;

  const rollupSql = Prisma.sql`
    WITH filtered_entries AS (
      SELECT e.* FROM GiveawayEntry e WHERE ${whereSql}
    ), entry_rollup AS (
      SELECT
        shopifyCustomerId AS customerId,
        MAX(customerName) AS customerName,
        MAX(customerEmail) AS customerEmail,
        COUNT(*) AS eligibleOrders,
        SUM(eligibleAmount) AS totalSpent,
        MAX(currencyCode) AS currencyCode,
        MAX(orderDate) AS lastPurchase
      FROM filtered_entries GROUP BY shopifyCustomerId
    ), ticket_rollup AS (
      SELECT
        e.shopifyCustomerId AS customerId,
        COUNT(t.id) AS ticketCount,
        GROUP_CONCAT(t.ticketNumber ORDER BY t.id SEPARATOR ',') AS ticketNumbers
      FROM filtered_entries e
      JOIN GiveawayTicket t ON t.entryId = e.id
        AND t.shop = ${session.shop}
        AND t.campaignId = ${campaign.id}
        AND t.status = 'VALID'
      GROUP BY e.shopifyCustomerId
    )
  `;

  if (url.searchParams.get("export") === "csv") {
    const exportRows = await prisma.$queryRaw<
      Array<{
        customerName: string;
        customerEmail: string;
        customerId: string;
        orderNumber: string;
        orderDate: Date;
        ticketNumber: string;
        ticketStatus: string;
      }>
    >(Prisma.sql`
      ${rollupSql}
      SELECT e.customerName, e.customerEmail, e.shopifyCustomerId AS customerId,
        e.orderNumber, e.orderDate, t.ticketNumber, t.status AS ticketStatus
      FROM filtered_entries e
      JOIN GiveawayTicket t ON t.entryId = e.id
        AND t.shop = ${session.shop}
        AND t.campaignId = ${campaign.id}
        AND t.status = 'VALID'
      WHERE e.shopifyCustomerId IN (
        SELECT er.customerId FROM entry_rollup er
        JOIN ticket_rollup tr ON tr.customerId = er.customerId
        WHERE ${havingSql}
      )
      ORDER BY e.customerEmail, e.orderDate, t.id
    `);
    const lines = [
      [
        "Customer name",
        "Customer email",
        "Shopify customer ID",
        "Order number",
        "Order date",
        "Ticket number",
        "Ticket status",
      ],
      ...exportRows.map((row) => [
        row.customerName,
        row.customerEmail,
        row.customerId,
        row.orderNumber,
        row.orderDate.toISOString(),
        row.ticketNumber,
        row.ticketStatus,
      ]),
    ].map((row) => row.map(csvCell).join(","));
    return new Response(`\uFEFF${lines.join("\r\n")}`, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="customer-tickets.csv"',
      },
    });
  }

  const [summaryRows, countRows, customerRows] = await Promise.all([
    prisma.$queryRaw<SummaryRow[]>(Prisma.sql`
      SELECT COUNT(t.id) AS totalTickets,
        COUNT(DISTINCT e.shopifyCustomerId) AS uniqueCustomers,
        COUNT(DISTINCT e.id) AS eligibleOrders
      FROM GiveawayEntry e
      JOIN GiveawayTicket t ON t.entryId = e.id
        AND t.shop = ${session.shop}
        AND t.campaignId = ${campaign.id}
        AND t.status = 'VALID'
      WHERE e.shop = ${session.shop}
        AND e.campaignId = ${campaign.id}
        AND e.status IN (${Prisma.join(VALID_ENTRY_STATUSES)})
    `),
    prisma.$queryRaw<CountRow[]>(Prisma.sql`
      ${rollupSql}
      SELECT COUNT(*) AS total FROM entry_rollup er
      JOIN ticket_rollup tr ON tr.customerId = er.customerId
      WHERE ${havingSql}
    `),
    prisma.$queryRaw<CustomerRow[]>(Prisma.sql`
      ${rollupSql}
      SELECT er.*, tr.ticketCount, tr.ticketNumbers
      FROM entry_rollup er
      JOIN ticket_rollup tr ON tr.customerId = er.customerId
      WHERE ${havingSql}
      ORDER BY ${orderSql}
      LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}
    `),
  ]);

  const totalCustomers = Number(countRows[0]?.total ?? 0);
  const summaryRow = summaryRows[0];
  const customers = customerRows.map((row) => ({
    customerId: row.customerId,
    customerName: row.customerName,
    customerEmail: row.customerEmail,
    eligibleOrders: Number(row.eligibleOrders),
    totalSpent: Number(row.totalSpent),
    currencyCode: row.currencyCode,
    ticketCount: Number(row.ticketCount),
    ticketPreview: (row.ticketNumbers ?? "")
      .split(",")
      .filter(Boolean)
      .slice(0, 4),
    lastPurchase: row.lastPurchase.toISOString(),
  }));

  const selectedId = url.searchParams.get("customer");
  const ticketPage = positiveInteger(url.searchParams.get("ticketPage"), 1);
  let selectedCustomer = null;
  if (selectedId) {
    const customer = customers.find((item) => item.customerId === selectedId);
    const selectedFromDb =
      customer ?? customerRows.find((item) => item.customerId === selectedId);
    if (selectedFromDb) {
      const entries = await prisma.giveawayEntry.findMany({
        where: {
          shop: session.shop,
          campaignId: campaign.id,
          shopifyCustomerId: selectedId,
          status: { in: VALID_ENTRY_STATUSES },
        },
        orderBy: { orderDate: "desc" },
      });
      const ticketWhere = {
        shop: session.shop,
        campaignId: campaign.id,
        status: "VALID",
        entry: {
          shopifyCustomerId: selectedId,
          status: { in: VALID_ENTRY_STATUSES },
        },
      };
      const [tickets, ticketCount] = await Promise.all([
        prisma.giveawayTicket.findMany({
          where: ticketWhere,
          orderBy: { id: "asc" },
          skip: (ticketPage - 1) * TICKET_PAGE_SIZE,
          take: TICKET_PAGE_SIZE,
          select: {
            ticketNumber: true,
            entry: { select: { orderNumber: true } },
          },
        }),
        prisma.giveawayTicket.count({ where: ticketWhere }),
      ]);
      const allTickets = tickets.map((ticket) => ({
        number: ticket.ticketNumber,
        orderNumber: ticket.entry.orderNumber,
      }));
      const first = entries[0];
      selectedCustomer = first
        ? {
            customerId: selectedId,
            customerName: first.customerName,
            customerEmail: first.customerEmail,
            eligibleOrders: entries.length,
            totalSpent: entries.reduce(
              (sum, entry) => sum + Number(entry.eligibleAmount),
              0,
            ),
            currencyCode: first.currencyCode,
            ticketCount,
            tickets: allTickets,
            ticketPage,
            totalTicketPages: Math.max(
              1,
              Math.ceil(ticketCount / TICKET_PAGE_SIZE),
            ),
            lastOrderNumber: first.orderNumber,
            lastPurchase: first.orderDate.toISOString(),
            source: first.source,
            status: first.status,
          }
        : null;
    }
  }

  return {
    filters,
    page,
    totalPages: Math.max(1, Math.ceil(totalCustomers / PAGE_SIZE)),
    summary: {
      totalTickets: Number(summaryRow?.totalTickets ?? 0),
      uniqueCustomers: Number(summaryRow?.uniqueCustomers ?? 0),
      eligibleOrders: Number(summaryRow?.eligibleOrders ?? 0),
    },
    customers,
    selectedCustomer,
  };
};

export default function CustomerTicketsPage() {
  const data = useLoaderData<typeof loader>();
  const syncFetcher = useFetcher<SyncActionData>();
  const navigate = useNavigate();
  const url =
    typeof window === "undefined" ? null : new URL(window.location.href);
  const average = data.summary.uniqueCustomers
    ? (data.summary.totalTickets / data.summary.uniqueCustomers).toFixed(1)
    : "0.0";
  const [searchQuery, setSearchQuery] = useState(data.filters.q);

  function searchCustomers() {
    const params = new URLSearchParams(url?.searchParams);
    const query = searchQuery.trim();
    if (query) params.set("q", query);
    else params.delete("q");
    params.delete("page");
    params.delete("customer");
    params.delete("ticketPage");
    navigate(`?${params.toString()}`);
  }

  function clearSearch() {
    const params = new URLSearchParams(url?.searchParams);
    params.delete("q");
    params.delete("page");
    params.delete("customer");
    params.delete("ticketPage");
    setSearchQuery("");
    navigate(`?${params.toString()}`);
  }

  return (
    <s-page heading="Customer Tickets" inlineSize="large">
      <s-button
        slot="primary-action"
        commandFor="sync-paid-orders-modal"
        command="--show"
        loading={syncFetcher.state !== "idle"}
      >
        Sync paid orders
      </s-button>
      <s-modal
        id="sync-paid-orders-modal"
        heading="Sync paid orders?"
        size="small"
      >
        <s-stack direction="block" gap="base">
          <s-paragraph>
            This will check paid Shopify orders and create any missing eligible
            giveaway entries and tickets for the active campaign.
          </s-paragraph>
          <s-paragraph color="subdued">
            Orders that are already synced will not receive duplicate entries or
            tickets. Orders that do not meet the campaign rules will be skipped.
          </s-paragraph>
        </s-stack>
        <s-button
          slot="primary-action"
          variant="primary"
          commandFor="sync-paid-orders-modal"
          command="--hide"
          onClick={() => syncFetcher.submit({}, { method: "post" })}
        >
          Yes, sync orders
        </s-button>
        <s-button
          slot="secondary-actions"
          variant="secondary"
          commandFor="sync-paid-orders-modal"
          command="--hide"
        >
          No
        </s-button>
      </s-modal>
      <s-stack direction="block" gap="base">
        <s-stack direction="inline" gap="base" alignItems="center">
          <s-text color="subdued">
            View ticket ownership, ticket numbers, and customer entry details.
          </s-text>
        </s-stack>

        {syncFetcher.data?.ok ? (
          <s-banner tone="success">
            Synced {syncFetcher.data.created} new orders.{" "}
            {syncFetcher.data.duplicates} already existed and{" "}
            {syncFetcher.data.skipped} were not eligible.
          </s-banner>
        ) : syncFetcher.data?.error ? (
          <s-banner tone="critical">{syncFetcher.data.error}</s-banner>
        ) : null}

        <s-grid
          gridTemplateColumns="repeat(auto-fit, minmax(180px, 1fr))"
          gap="base"
        >
          {(
            [
              {
                label: "Total Tickets Issued",
                value: data.summary.totalTickets,
                icon: "status",
                colorClass: styles.summaryGreen,
              },
              {
                label: "Unique Customers",
                value: data.summary.uniqueCustomers,
                icon: "profile",
                colorClass: styles.summaryPurple,
              },
              {
                label: "Average Tickets per Customer",
                value: average,
                icon: "chart-vertical",
                colorClass: styles.summaryBlue,
              },
              {
                label: "Total Eligible Orders",
                value: data.summary.eligibleOrders,
                icon: "order",
                colorClass: styles.summaryAmber,
              },
            ] as const
          ).map(({ label, value, icon, colorClass }) => (
            <div key={label} className={`${styles.summaryCard} ${colorClass}`}>
              <s-stack direction="block" gap="small">
                <s-stack direction="inline" gap="small" alignItems="center">
                  <s-icon type={icon} tone="neutral"></s-icon>
                  <s-text type="strong">{label}</s-text>
                </s-stack>
                <s-heading>{value}</s-heading>
              </s-stack>
            </div>
          ))}
        </s-grid>

        <s-section heading="Customers" padding="none">
          <s-box padding="base">
            <s-grid
              gridTemplateColumns={
                data.filters.q
                  ? "minmax(0, 1fr) auto auto"
                  : "minmax(0, 1fr) auto"
              }
              gap="base"
              alignItems="end"
            >
              <s-search-field
                label="Search customers"
                labelAccessibilityVisibility="exclusive"
                name="q"
                placeholder="Search by customer name or email"
                value={searchQuery}
                onInput={(event) =>
                  setSearchQuery(event.currentTarget.value ?? "")
                }
              ></s-search-field>
              <s-button variant="primary" onClick={searchCustomers}>
                Search
              </s-button>
              {data.filters.q ? (
                <s-button onClick={clearSearch}>Clear</s-button>
              ) : null}
            </s-grid>
          </s-box>
          {data.customers.length === 0 ? (
            <s-box padding="large">
              <s-stack direction="block" gap="small" alignItems="center">
                <s-heading>
                  {data.filters.q
                    ? "No matching customers found"
                    : "No ticket entries yet"}
                </s-heading>
                <s-text color="subdued">
                  {data.filters.q
                    ? "Try searching with a different customer name or email address."
                    : "Persisted eligible entries and ticket assignments will appear here."}
                </s-text>
              </s-stack>
            </s-box>
          ) : (
            <s-table
              paginate
              hasPreviousPage={data.page > 1}
              hasNextPage={data.page < data.totalPages}
              onPreviousPage={() =>
                navigate(
                  pageHref(url ?? new URL("http://local"), data.page - 1),
                )
              }
              onNextPage={() =>
                navigate(
                  pageHref(url ?? new URL("http://local"), data.page + 1),
                )
              }
            >
              <s-table-header-row>
                <s-table-header listSlot="primary">Customer</s-table-header>
                <s-table-header listSlot="labeled">Email</s-table-header>
                <s-table-header>Orders</s-table-header>
                <s-table-header>Total spent</s-table-header>
                <s-table-header>Tickets</s-table-header>
                <s-table-header>Ticket preview</s-table-header>
                <s-table-header>Last purchase</s-table-header>
                <s-table-header>Action</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {data.customers.map((customer) => {
                  const params = new URLSearchParams(url?.searchParams);
                  params.set("customer", customer.customerId);
                  return (
                    <s-table-row key={customer.customerId}>
                      <s-table-cell>
                        <s-stack
                          direction="inline"
                          gap="small"
                          alignItems="center"
                        >
                          <s-avatar
                            initials={customerInitials(customer.customerName)}
                            size="small"
                          ></s-avatar>
                          <s-text type="strong">{customer.customerName}</s-text>
                        </s-stack>
                      </s-table-cell>
                      <s-table-cell>{customer.customerEmail}</s-table-cell>
                      <s-table-cell>{customer.eligibleOrders}</s-table-cell>
                      <s-table-cell>
                        {new Intl.NumberFormat(undefined, {
                          style: "currency",
                          currency: customer.currencyCode,
                        }).format(customer.totalSpent)}
                      </s-table-cell>
                      <s-table-cell>
                        <s-badge tone="info">{customer.ticketCount}</s-badge>
                      </s-table-cell>
                      <s-table-cell>
                        {customer.ticketPreview.join(", ")}
                        {customer.ticketCount > 4 ? " …" : ""}
                      </s-table-cell>
                      <s-table-cell>
                        {new Date(customer.lastPurchase).toLocaleDateString()}
                      </s-table-cell>
                      <s-table-cell>
                        <s-button href={`?${params.toString()}`}>
                          View Tickets
                        </s-button>
                      </s-table-cell>
                    </s-table-row>
                  );
                })}
              </s-table-body>
            </s-table>
          )}
        </s-section>

        {data.selectedCustomer ? (
          <s-section
            heading={`Tickets for ${data.selectedCustomer.customerName}`}
          >
            <s-stack direction="block" gap="base">
              <s-grid
                gridTemplateColumns="repeat(auto-fit, minmax(160px, 1fr))"
                gap="base"
              >
                <s-box>
                  <s-text color="subdued">Email</s-text>
                  <br />
                  <s-text>{data.selectedCustomer.customerEmail}</s-text>
                </s-box>
                <s-box>
                  <s-text color="subdued">Eligible orders</s-text>
                  <br />
                  <s-text type="strong">
                    {data.selectedCustomer.eligibleOrders}
                  </s-text>
                </s-box>
                <s-box>
                  <s-text color="subdued">Eligible value</s-text>
                  <br />
                  <s-text type="strong">
                    {new Intl.NumberFormat(undefined, {
                      style: "currency",
                      currency: data.selectedCustomer.currencyCode,
                    }).format(data.selectedCustomer.totalSpent)}
                  </s-text>
                </s-box>
                <s-box>
                  <s-text color="subdued">Valid tickets</s-text>
                  <br />
                  <s-text type="strong">
                    {data.selectedCustomer.ticketCount}
                  </s-text>
                </s-box>
                <s-box>
                  <s-text color="subdued">Status</s-text>
                  <br />
                  <s-badge tone="success">
                    {data.selectedCustomer.status}
                  </s-badge>
                </s-box>
              </s-grid>
              <s-text>
                Last eligible order: {data.selectedCustomer.lastOrderNumber} ·{" "}
                {new Date(data.selectedCustomer.lastPurchase).toLocaleString()}{" "}
                · Source: {data.selectedCustomer.source}
              </s-text>
              <s-stack direction="inline" gap="small">
                {data.selectedCustomer.tickets.map((ticket) => (
                  <s-chip key={`${ticket.orderNumber}-${ticket.number}`}>
                    {ticket.number} · {ticket.orderNumber}
                  </s-chip>
                ))}
              </s-stack>
              <s-stack direction="inline" gap="base" alignItems="center">
                {(() => {
                  const previous = new URLSearchParams(url?.searchParams);
                  const next = new URLSearchParams(url?.searchParams);
                  previous.set(
                    "ticketPage",
                    String(data.selectedCustomer.ticketPage - 1),
                  );
                  next.set(
                    "ticketPage",
                    String(data.selectedCustomer.ticketPage + 1),
                  );
                  return (
                    <>
                      <s-button
                        href={`?${previous.toString()}`}
                        disabled={data.selectedCustomer.ticketPage <= 1}
                      >
                        Previous tickets
                      </s-button>
                      <s-text color="subdued">
                        Ticket page {data.selectedCustomer.ticketPage} of{" "}
                        {data.selectedCustomer.totalTicketPages}
                      </s-text>
                      <s-button
                        href={`?${next.toString()}`}
                        disabled={
                          data.selectedCustomer.ticketPage >=
                          data.selectedCustomer.totalTicketPages
                        }
                      >
                        Next tickets
                      </s-button>
                    </>
                  );
                })()}
              </s-stack>
            </s-stack>
          </s-section>
        ) : null}
      </s-stack>
    </s-page>
  );
}
