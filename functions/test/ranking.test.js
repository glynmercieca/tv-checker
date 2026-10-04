import test from "node:test";
import assert from "node:assert/strict";
import { selectBestModels, priceNumber } from "../src/ranking.js";

const tv = (row, fields = {}) => ({ row, stock: "In stock", price: "€1,000.00", panelTechnology: "QLED", refreshRate: "144 Hz", os: "VIDAA", ...fields });

test("requires known stock, panel technology, and at least 120 Hz", () => {
  const result = selectBestModels([
    tv(2, { panelTechnology: "OLED", stock: "Out of stock" }),
    tv(3, { stock: "Pre-order" }), tv(4, { refreshRate: "60 Hz" }),
    tv(5, { refreshRate: "Not listed" }), tv(6, { panelTechnology: "Not listed" }),
    tv(7, { stock: "Low stock" }),
  ]);
  assert.equal(result.overall.row, 7);
  assert.equal(result.budget.row, 7);
  assert.equal(selectBestModels([tv(2, { stock: null })]).overall, null);
});

test("ranks panels then gaming refresh, with Google TV a bonus rather than a requirement", () => {
  const result = selectBestModels([
    tv(2, { os: "Google TV", refreshRate: "240 Hz" }),
    tv(3, { panelTechnology: "QD-Mini LED", refreshRate: "120 Hz", price: "€2,000" }),
    tv(4, { panelTechnology: "QD-Mini LED", refreshRate: "144 Hz", price: "€2,100" }),
  ]);
  assert.equal(result.overall.row, 4);
  assert.equal(result.budget.row, 2);
  assert.equal(selectBestModels([tv(2), tv(3, { os: "Google TV" })]).overall.row, 3);
});

test("budget is strictly under 1200 and excludes unverified prices", () => {
  const result = selectBestModels([
    tv(2, { price: "€1,200.00", panelTechnology: "OLED" }),
    tv(3, { price: null, panelTechnology: "Mini LED" }),
    tv(4, { price: "€1,199.99" }),
  ]);
  assert.equal(result.overall.row, 2);
  assert.equal(result.budget.row, 4);
  assert.equal(selectBestModels([tv(2, { price: null })]).overall.row, 2);
  assert.equal(selectBestModels([tv(2, { price: null })]).budget, null);
});

test("gaming features, then cheaper price, break otherwise equal ties", () => {
  assert.equal(selectBestModels([tv(2), tv(3, { vrr: "Yes", price: "€1,100" })]).overall.row, 3);
  assert.equal(selectBestModels([tv(2, { price: "€1,100" }), tv(3)]).overall.row, 3);
});

test("price parsing handles both retailer conventions without inventing prices", () => {
  assert.equal(priceNumber("€1,199.00"), 1199);
  assert.equal(priceNumber("€1.199,00"), 1199);
  assert.equal(priceNumber("1199,00"), 1199);
  assert.equal(priceNumber("Not listed"), null);
  assert.equal(priceNumber("from €999"), null);
});
