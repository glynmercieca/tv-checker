import test from "node:test";
import assert from "node:assert/strict";
import { meetsMinimumRefreshRate, runUpdater } from "../src/updater.js";

test("accepts only TVs with a verified maximum refresh rate of at least 120 Hz", () => {
  assert.equal(meetsMinimumRefreshRate("120 Hz"), true);
  assert.equal(meetsMinimumRefreshRate("60 Hz (120 Hz Game Accelerator)"), true);
  assert.equal(meetsMinimumRefreshRate("100 Hz native (144 Hz VRR)"), true);
  assert.equal(meetsMinimumRefreshRate("60 Hz"), false);
  assert.equal(meetsMinimumRefreshRate("Not listed"), false);
  assert.equal(meetsMinimumRefreshRate(""), false);
});

test("supports a configurable minimum refresh rate", () => {
  assert.equal(meetsMinimumRefreshRate("120 Hz", 144), false);
  assert.equal(meetsMinimumRefreshRate("144 Hz", 144), true);
});

function updaterFixture(dryRun) {
  const writes = [], email = [];
  const headers = ["Checked at (UTC)", "Retailer", "Brand", "Model", "Product link", "Price (€)", "Stock", "Check status"];
  const sheets = { spreadsheets: {
    get: async () => ({ data: { sheets: [
      { properties: { sheetId: 7, title: "Sheet2" } },
      { properties: { sheetId: 9, title: "Price history" } },
    ] } }),
    batchUpdate: async (args) => { writes.push(["format", args]); return { data: {} }; },
    values: {
      get: async (args) => ({ data: { values: args.range.includes("A1:H1") ? [headers] : [
        ["Shop", "TCL", "85C7K", "2026", "https://example.com/current", "€1,099.00", "In stock", "QLED", "144 Hz", "Google TV", "Yes", "Yes"],
        ["Shop", "Sony", "85OLD", "2026", "https://example.com/failed", "€999.00", "In stock", "OLED", "240 Hz"],
      ] } }),
      update: async (args) => writes.push(["update", args]),
      batchUpdate: async (args) => writes.push(["values", args]),
      append: async (args) => writes.push(["history", args]),
    },
  } };
  return { writes, email, options: {
    sheets, dryRun, gptEnabled: false,
    scrapeProduct: async (url) => {
      if (url.endsWith("failed")) throw new Error("Retailer blocked");
      if (url.endsWith("unknown")) return { price: null, stock: null };
      if (url.endsWith("current")) return { price: "€1,099.00", stock: "In stock", specs: { panelTechnology: "Mini LED", refreshRate: "144 Hz" } };
      return { title: "Sony K85XR70 85-inch TV", price: "€2,500.00", stock: "In stock", specs: { panelTechnology: "OLED", refreshRate: "144 Hz" } };
    },
    discoverCandidates: async () => ({ candidates: [{ retailer: "New Shop", url: "https://example.com/new" }], errors: [] }),
    sendStatusEmail: async (summary) => { email.push(summary); },
  } };
}

test("writes recommendations and records unchanged prices, additions, and failed checks", async () => {
  const fixture = updaterFixture(false);
  const summary = await runUpdater(fixture.options);
  assert.equal(summary.modified.length, 0);
  assert.equal(summary.specificationsUpdated, 1);
  assert.equal(summary.best.overall.row, 4);
  assert.equal(summary.best.budget.row, 2);
  assert.equal(summary.historyCount, 3);
  const history = fixture.writes.find(([kind]) => kind === "history")[1].requestBody.values;
  assert.equal(history[0][5], 1099);
  assert.equal(history[1][5], "");
  assert.match(history[1][7], /Failed/);
  assert.equal(history[2][5], 2500);
  assert.ok(history.every((row) => /Z$/.test(row[0])));
  assert.equal(fixture.email.length, 1);
});

test("dry runs calculate winners without creating tabs, highlights, or history rows", async () => {
  const fixture = updaterFixture(true);
  const summary = await runUpdater(fixture.options);
  assert.equal(fixture.writes.length, 0);
  assert.equal(summary.historyCount, 3);
  assert.equal(summary.best.budget.row, 2);
});

test("unknown current stock cannot reuse stale sheet stock for recommendations", async () => {
  const fixture = updaterFixture(true);
  fixture.options.discoveryEnabled = false;
  fixture.options.scrapeProduct = async () => ({ price: null, stock: null });
  const summary = await runUpdater(fixture.options);
  assert.equal(summary.best.overall, null);
  assert.equal(summary.best.budget, null);
  assert.equal(summary.modified.length, 0);
});

test("later discovery failures still preserve completed price observations", async () => {
  const fixture = updaterFixture(false);
  fixture.options.discoverCandidates = async () => { throw new Error("Discovery unavailable"); };
  await assert.rejects(runUpdater(fixture.options), /Discovery unavailable/);
  assert.equal(fixture.writes.find(([kind]) => kind === "history")[1].requestBody.values.length, 2);
});

test("accepts a verified 85-inch description when the product title omits size", async () => {
  const fixture = updaterFixture(true);
  fixture.options.scrapeProduct = async () => ({
    title: "Sony K85XR70", televisionVerified: true, screenSize: "Screen Size: 85 inches",
    price: "€2,999.00", stock: "In stock", specs: { panelTechnology: "Mini LED", refreshRate: "120 Hz" },
  });
  assert.equal((await runUpdater(fixture.options)).added.length, 1);
  fixture.options.scrapeProduct = async () => ({
    title: "Sony K85XR70", televisionVerified: true, screenSize: "Screen Size: 75 inches",
    price: "€2,999.00", stock: "In stock", specs: { panelTechnology: "Mini LED", refreshRate: "120 Hz" },
  });
  assert.equal((await runUpdater(fixture.options)).added.length, 0);
});
