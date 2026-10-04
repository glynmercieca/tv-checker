import test from "node:test";
import assert from "node:assert/strict";
import { appendProducts, readProducts, appendPriceHistory, highlightBestModels, writeSpecifications } from "../src/sheets.js";

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

test("appends A:L and applies currency/text formats", async () => {
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
    panelTechnology: "Mini LED", refreshRate: "144 Hz", os: "Google TV",
    vrr: "Yes", hdmi21: "Yes",
  }], 40);
  assert.equal(calls[0][1].range, "'Sheet2'!A40:L40");
  assert.equal(calls[0][1].requestBody.values[0][5], 1099);
  assert.deepEqual(calls[0][1].requestBody.values[0].slice(7), [
    "Mini LED", "144 Hz", "Google TV", "Yes", "Yes",
  ]);
  assert.equal(calls[1][1].requestBody.requests[0].repeatCell.range.startRowIndex, 39);
});

test("creates a price-history tab and appends numeric observations safely", async () => {
  const calls = [];
  const sheets = { spreadsheets: {
    get: async () => ({ data: { sheets: [] } }),
    batchUpdate: async (args) => {
      calls.push(["batch", args]);
      return { data: { replies: [{ addSheet: { properties: { sheetId: 9, title: "Price history" } } }] } };
    },
    values: {
      get: async () => ({ data: {} }),
      update: async (args) => calls.push(["header", args]),
      append: async (args) => calls.push(["history", args]),
    },
  } };
  await appendPriceHistory(sheets, { spreadsheetId: "id", sheetName: "Sheet2" }, [
    { checkedAt: "2026-10-04T09:00:00Z", retailer: "Shop", brand: "TCL", model: "=85TV", url: "https://example.com/tv", price: "€1.199,00", stock: "In stock" },
    { checkedAt: "2026-10-04T09:00:01Z", retailer: "Shop", brand: "TCL", model: "85TV", url: "https://example.com/tv", price: null, error: "timeout" },
  ]);
  assert.equal(calls[0][1].requestBody.requests[0].addSheet.properties.title, "Price history");
  const append = calls.find(([kind]) => kind === "history")[1];
  assert.equal(append.valueInputOption, "RAW");
  assert.equal(append.requestBody.values[0][5], 1199);
  assert.equal(append.requestBody.values[0][3], "=85TV");
  assert.equal(append.requestBody.values[1][5], "");
  assert.equal(append.requestBody.values[1][7], "Failed: timeout");
});

test("history preserves an existing tab and rejects incompatible headers", async () => {
  let mutations = 0;
  const sheets = { spreadsheets: {
    get: async () => ({ data: { sheets: [{ properties: { sheetId: 9, title: "Price history" } }] } }),
    values: { get: async () => ({ data: { values: [["My own data"]] } }) },
    batchUpdate: async () => { mutations++; },
  } };
  await assert.rejects(appendPriceHistory(sheets, { spreadsheetId: "id", sheetName: "Sheet2" }, []), /Unexpected headers/);
  assert.equal(mutations, 0);
  await assert.rejects(appendPriceHistory(sheets, { spreadsheetId: "id", sheetName: "Price history" }, []), /separate sheet/);
});

test("highlights exactly the model column and replaces only owned rules", async () => {
  let body;
  const rule = (formula) => ({ booleanRule: { condition: { values: [{ userEnteredValue: formula }] } } });
  const sheets = { spreadsheets: {
    get: async () => ({ data: { sheets: [{ properties: { sheetId: 7, title: "Sheet2" }, conditionalFormats: [rule('=N("TV_CHECKER_HIGHLIGHT_OVERALL")=0'), rule("=C2<>\"\"")] }] } }),
    batchUpdate: async (args) => { body = args.requestBody; },
  } };
  await highlightBestModels(sheets, { spreadsheetId: "id", sheetName: "Sheet2" }, { overall: { row: 4 }, budget: { row: 8 } });
  assert.deepEqual(body.requests[0], { deleteConditionalFormatRule: { sheetId: 7, index: 0 } });
  const rules = body.requests.slice(1).map((request) => request.addConditionalFormatRule.rule);
  assert.ok(rules.every((item) => item.ranges[0].startColumnIndex === 2 && item.ranges[0].endColumnIndex === 3));
  assert.match(rules[0].booleanRule.condition.values[0].userEnteredValue, /ROW\(\)=4/);
  assert.equal(rules[0].booleanRule.format.backgroundColor.red, 81 / 255);
  assert.equal(rules[1].booleanRule.format.backgroundColor.red, 208 / 255);
});

test("a shared winner shows both colors and no winner clears stale rules", async () => {
  const calls = [];
  const sheets = { spreadsheets: {
    get: async () => ({ data: { sheets: [{ properties: { sheetId: 7, title: "Sheet2" }, conditionalFormats: [{ booleanRule: { condition: { values: [{ userEnteredValue: '=N("TV_CHECKER_HIGHLIGHT_BOTH")=0' }] } } }] }] } }),
    batchUpdate: async (args) => calls.push(args.requestBody.requests),
  } };
  await highlightBestModels(sheets, { spreadsheetId: "id", sheetName: "Sheet2" }, { overall: { row: 2 }, budget: { row: 2 } });
  const format = calls[0][1].addConditionalFormatRule.rule.booleanRule.format;
  assert.equal(format.backgroundColor.green, 172 / 255);
  assert.equal(format.textFormat.foregroundColor.blue, 230 / 255);
  await highlightBestModels(sheets, { spreadsheetId: "id", sheetName: "Sheet2" }, { overall: null, budget: null });
  assert.equal(calls[1].length, 1);
  assert.ok(calls[1][0].deleteConditionalFormatRule);
});

test("updates specifications only in H:L", async () => {
  let request;
  const sheets = { spreadsheets: { values: { batchUpdate: async (args) => { request = args; } } } };
  await writeSpecifications(sheets, { spreadsheetId: "id", sheetName: "Sheet2" }, [{ row: 5, panelTechnology: "QLED", refreshRate: "144 Hz", os: "Google TV", vrr: "Yes", hdmi21: "No" }]);
  assert.equal(request.requestBody.data[0].range, "'Sheet2'!H5:L5");
  assert.deepEqual(request.requestBody.data[0].values[0], ["QLED", "144 Hz", "Google TV", "Yes", "No"]);
});
