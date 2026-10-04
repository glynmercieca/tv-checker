import test from "node:test";
import assert from "node:assert/strict";
import { buildPriceHistory, historyDate } from "../src/price-history.js";

const headers = ["Retailer", "Brand", "Model", "Product link"];
const observation = (fields = {}) => ({ checkedAt: "2026-10-04T09:00:00Z", retailer: "Shop", brand: "TCL", model: "85C7K", url: "https://example.com/tv", price: "€1,099.00", ...fields });

test("creates identity columns and one numeric price per Malta date", () => {
  const result = buildPriceHistory([], [observation()]);
  assert.deepEqual(result.values, [[...headers, "2026-10-04"], ["Shop", "TCL", "85C7K", "https://example.com/tv", 1099]]);
  assert.equal(historyDate("2026-10-04T22:30:00Z"), "2026-10-05");
  assert.equal(historyDate("2026-11-01T23:30:00Z"), "2026-11-02");
});

test("extends date columns without losing prices or duplicating product rows", () => {
  const existing = [[...headers, "2026-10-03"], ["Shop", "TCL", "85C7K", "https://example.com/tv", "€1,199.00"]];
  const result = buildPriceHistory(existing, [observation()]);
  assert.deepEqual(result.values[0], [...headers, "2026-10-03", "2026-10-04"]);
  assert.deepEqual(result.values[1].slice(4), [1199, 1099]);
  assert.equal(result.values.length, 2);
});

test("same-day latest verified check wins while later failed checks preserve it", () => {
  const result = buildPriceHistory([], [
    observation({ checkedAt: "2026-10-04T11:00:00Z", price: null, error: "timeout" }),
    observation({ checkedAt: "2026-10-04T10:00:00Z", price: "€999.00" }),
    observation(),
  ]);
  assert.equal(result.values[1][4], 999);
  assert.equal(result.values.length, 2);
  assert.equal(buildPriceHistory(result.values, [observation({ price: null, error: "blocked" })]).values[1][4], 999);
});

test("keeps different retailers separate and new models blank on earlier dates", () => {
  const result = buildPriceHistory([[...headers, "2026-10-03"], ["Shop", "TCL", "85C7K", "https://example.com/tv", 1200]], [
    observation({ retailer: "Other", url: "https://other.com/tv" }),
    observation({ model: "85C8K", url: "https://example.com/new", price: null }),
  ]);
  assert.equal(result.values.length, 4);
  assert.deepEqual(result.values[2].slice(4), ["", 1099]);
  assert.deepEqual(result.values[3].slice(4), ["", ""]);
});

test("updates a changed product link without creating a new model row", () => {
  const existing = [[...headers, "2026-10-03"], ["Shop", "TCL", "85C7K", "https://example.com/old", 1199]];
  const result = buildPriceHistory(existing, [observation()]);
  assert.equal(result.values.length, 2);
  assert.equal(result.values[1][3], "https://example.com/tv");
});

test("converts the old check log into date columns with latest daily prices", () => {
  const legacy = [
    ["Checked at (UTC)", "Retailer", "Brand", "Model", "Product link", "Price (€)", "Stock", "Check status"],
    ["2026-10-03T09:00:00Z", "Shop", "TCL", "85C7K", "https://example.com/tv", 1199, "In stock", "Checked"],
    ["2026-10-03T11:00:00Z", "Shop", "TCL", "85C7K", "https://example.com/tv", 1150, "In stock", "Checked"],
    ["2026-10-03T12:00:00Z", "Shop", "TCL", "85C7K", "https://example.com/tv", "", "Unknown", "Failed: timeout"],
  ];
  const result = buildPriceHistory(legacy, [observation()]);
  assert.equal(result.migrating, true);
  assert.deepEqual(result.values[1].slice(4), [1150, 1099]);
});

test("rejects incompatible tables, duplicate dates, and malformed timestamps", () => {
  assert.throws(() => buildPriceHistory([["My notes"]], []), /Unexpected headers/);
  assert.throws(() => buildPriceHistory([[...headers, "2026-10-04", "2026-10-04"]], []), /unique/);
  assert.throws(() => buildPriceHistory([[...headers, "2026-02-30"]], []), /YYYY-MM-DD/);
  assert.throws(() => buildPriceHistory([], [observation({ checkedAt: "bad date" })]), /timestamp/);
});
