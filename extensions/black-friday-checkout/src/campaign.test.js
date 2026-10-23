import assert from "node:assert/strict";
import test from "node:test";

import {
  getCheckoutMessage,
  getCheckoutMessages,
  getTicketCountFromTotal,
  getTicketSummary,
  isCampaignActive,
  parseCampaignConfig,
  renderThankYouMessage,
  renderTicketMessage,
} from "./campaign.js";

const activeConfig = {
  enabled: true,
  startAt: "2026-10-01T00:00:00.000Z",
  endAt: "2026-10-31T23:59:59.999Z",
  messages: { en: "English message", fr: "Message français" },
};
const now = Date.parse("2026-10-21T12:00:00.000Z");

test("active campaign is visible", () => {
  assert.equal(isCampaignActive(activeConfig, now), true);
});

test("disabled campaign is hidden", () => {
  assert.equal(
    isCampaignActive({ ...activeConfig, enabled: false }, now),
    false,
  );
});

test("future campaign is hidden", () => {
  assert.equal(
    isCampaignActive(
      { ...activeConfig, startAt: "2026-11-01T00:00:00.000Z" },
      now,
    ),
    false,
  );
});

test("expired campaign is hidden", () => {
  assert.equal(
    isCampaignActive(
      { ...activeConfig, endAt: "2026-10-20T23:59:59.999Z" },
      now,
    ),
    false,
  );
});

test("French checkout language receives French", () => {
  assert.equal(getCheckoutMessage(activeConfig, "fr-FR"), "Message français");
  assert.equal(getCheckoutMessage(activeConfig, "fr-CA"), "Message français");
});

test("non-French checkout languages receive English", () => {
  assert.equal(getCheckoutMessage(activeConfig, "en-CA"), "English message");
});

test("missing French falls back to English", () => {
  assert.equal(
    getCheckoutMessage(
      { ...activeConfig, messages: { en: "English message", fr: "" } },
      "fr",
    ),
    "English message",
  );
});

test("configured checkout lines use French with English field fallbacks", () => {
  const config = {
    ...activeConfig,
    messages: {
      en: {
        entry: "English entry",
        tickets: "English {tickets}",
        motivation: "English motivation",
      },
      fr: {
        entry: "Entrée française",
        tickets: "",
        motivation: "Motivation française",
      },
    },
  };
  assert.deepEqual(getCheckoutMessages(config, "fr-BE"), {
    entry: "Entrée française",
    tickets: "English {tickets}",
    motivation: "Motivation française",
  });
});

test("ticket placeholders map to order tickets then accumulated total", () => {
  assert.equal(
    renderTicketMessage(
      "This order earns you {tickets} tickets. Your total will be {total-tickets} tickets.",
      47,
      1209,
    ),
    "This order earns you 47 tickets. Your total will be 1209 tickets.",
  );
});

test("thank-you ticket placeholder maps to the Shopify cart total", () => {
  assert.equal(
    renderThankYouMessage("You earn total {tickets-num} tickets.", 47),
    "You earn total 47 tickets.",
  );
  assert.equal(
    renderThankYouMessage("Legacy total: {tickets}.", 47),
    "Legacy total: 47.",
  );
});

test("missing or malformed settings are handled safely", () => {
  assert.equal(parseCampaignConfig("not-json"), null);
  assert.equal(isCampaignActive(parseCampaignConfig("not-json"), now), false);
});

test("checkout total determines the whole ticket count", () => {
  assert.equal(getTicketCountFromTotal(200), 200);
  assert.equal(getTicketCountFromTotal("200.75"), 200);
  assert.equal(getTicketCountFromTotal(0), 0);
  assert.equal(getTicketCountFromTotal(-10), 0);
  assert.equal(getTicketCountFromTotal(undefined), 0);
});

test("new order tickets are added to the customer's previous tickets", () => {
  assert.deepEqual(getTicketSummary(209, 1000), {
    orderTickets: 209,
    totalTickets: 1209,
  });
  assert.deepEqual(getTicketSummary(25.9, undefined), {
    orderTickets: 25,
    totalTickets: 25,
  });
});
