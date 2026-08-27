import test from "node:test";
import assert from "node:assert/strict";
import { appendProducts, readProducts } from "../src/sheets.js";

test("reads existing rows and returns the next unused row", async () => {
  const sheets = {
    spreadsheets: {
      values: {
        get: async () => ({ data: { values: [
          ["Shop", "Brand", "Model", "2026", "https://example.com/tv", "€1,000.00", "In stock"],
          [],
          ["Shop", "Brand", "Model 2", "", "https://example.com/tv2", "", "Out of stock"],
        ] } }),
      },
    },
  };
  const result = await readProducts(sheets, { spreadsheetId: "id", sheetName: "Sheet2" });
  assert.equal(result.nextRow, 5);
  assert.deepEqual(result.products.map((item) => item.row), [2, 4]);
});

test("appends A:G and applies currency/text formats", async () => {
  const calls = [];
  const sheets = {
    spreadsheets: {
      values: {
        update: async (args) => { calls.push(["values", args]); },
      },
      get: async () => ({ data: { sheets: [{ properties: { sheetId: 123, title: "Sheet2" } }] } }),
      batchUpdate: async (args) => { calls.push(["format", args]); },
    },
  };
  await appendProducts(sheets, { spreadsheetId: "id", sheetName: "Sheet2" }, [{
    retailer: "Shop", brand: "Brand", model: "TV85", year: "2026",
    url: "https://example.com/tv", price: "€1,099.00", stock: "In stock",
  }], 40);
  assert.equal(calls[0][1].range, "'Sheet2'!A40:G40");
  assert.equal(calls[0][1].requestBody.values[0][5], 1099);
  assert.equal(calls[1][1].requestBody.requests[0].repeatCell.range.startRowIndex, 39);
});
