import { google } from "googleapis";
import { priceNumber } from "./ranking.js";
import { buildPriceHistory } from "./price-history.js";

const scope = "https://www.googleapis.com/auth/spreadsheets";

function credentialsFromEnvironment() {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) return undefined;
  try {
    return JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  } catch (error) {
    throw new Error(`GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON: ${error.message}`);
  }
}

export function createSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: credentialsFromEnvironment(),
    scopes: [scope],
  });
  return google.sheets({ version: "v4", auth });
}

export async function resolveProductSheet(sheets, { spreadsheetId, sheetName, historySheetName = "Price history" }) {
  const metadata = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets.properties(sheetId,title,gridProperties.columnCount)",
  });
  const tabs = (metadata.data.sheets || []).map((item) => item.properties).filter(Boolean);
  const exact = tabs.find((tab) => tab.title === sheetName);
  if (exact) return exact.title;
  const normalized = (value) => String(value || "").trim().toLowerCase();
  const matches = tabs.filter((tab) => normalized(tab.title) === normalized(sheetName));
  if (matches.length === 1) return matches[0].title;

  // A renamed default tab is safe to discover only when exactly one tab has the
  // expected product-table columns. Never select an arbitrary first tab.
  const candidates = tabs.filter((tab) => normalized(tab.title) !== normalized(historySheetName) &&
    (tab.gridProperties?.columnCount ?? 26) >= 7);
  if (candidates.length) {
    const headers = await sheets.spreadsheets.values.batchGet({
      spreadsheetId,
      ranges: candidates.map((tab) => `'${tab.title.replaceAll("'", "''")}'!A1:G1`),
      valueRenderOption: "FORMATTED_VALUE",
    });
    const productTabs = candidates.filter((_, index) => {
      const row = headers.data.valueRanges?.[index]?.values?.[0] || [];
      return /retailer|shop|store/i.test(row[0] || "") &&
        /brand|manufacturer/i.test(row[1] || "") &&
        /model|product/i.test(row[2] || "") &&
        /url|link|product\s*page/i.test(row[4] || "") &&
        /price|cost/i.test(row[5] || "") && /stock|availability/i.test(row[6] || "");
    });
    if (productTabs.length === 1) {
      console.warn(`SHEET Configured tab ${JSON.stringify(sheetName)} was not found; using verified product tab ${JSON.stringify(productTabs[0].title)}`);
      return productTabs[0].title;
    }
  }
  throw new Error(`Product tab ${JSON.stringify(sheetName)} was not found or could not be resolved uniquely. Available tabs: ${tabs.map((tab) => JSON.stringify(tab.title)).join(", ") || "none"}. Set the GitHub Actions repository variable SHEET_NAME to the exact product tab name (not the spreadsheet file name).`);
}

export async function readProducts(sheets, { spreadsheetId, sheetName }) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${sheetName.replaceAll("'", "''")}'!A2:L`,
    valueRenderOption: "FORMATTED_VALUE",
  });

  const rows = response.data.values || [];
  const products = rows
    .map((values, index) => ({
      row: index + 2,
      retailer: values[0] || "",
      brand: values[1] || "",
      model: values[2] || "",
      url: values[4] || "",
      currentPrice: values[5] || "",
      currentStock: values[6] || "",
      panelTechnology: values[7] || "",
      refreshRate: values[8] || "",
      os: values[9] || "",
      vrr: values[10] || "",
      hdmi21: values[11] || "",
    }))
    .filter((product) => /^https?:\/\//i.test(product.url));
  return { products, nextRow: rows.length + 2 };
}

export async function writeUpdates(
  sheets,
  { spreadsheetId, sheetName },
  updates,
) {
  if (!updates.length) return;
  const quotedSheet = `'${sheetName.replaceAll("'", "''")}'`;
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: "USER_ENTERED",
      data: updates.map(({ row, price, stock }) => ({
        range: `${quotedSheet}!F${row}:G${row}`,
        majorDimension: "ROWS",
        values: [[price, stock]],
      })),
    },
  });
}

function euroNumber(value) {
  return priceNumber(value) ?? "";
}

export async function writeSpecifications(sheets, { spreadsheetId, sheetName }, updates) {
  if (!updates.length) return;
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: "RAW",
      data: updates.map((product) => ({
        range: `'${sheetName.replaceAll("'", "''")}'!H${product.row}:L${product.row}`,
        values: [[product.panelTechnology, product.refreshRate, product.os, product.vrr, product.hdmi21]],
      })),
    },
  });
}

export async function appendPriceHistory(sheets, config, observations) {
  const { spreadsheetId, sheetName, historySheetName = "history" } = config;
  if (historySheetName === sheetName) throw new Error("Price history must use a separate sheet");
  const metadata = await sheets.spreadsheets.get({
    spreadsheetId, fields: "sheets.properties(sheetId,title,gridProperties(rowCount,columnCount))",
  });
  let sheet = metadata.data.sheets?.find((item) => item.properties?.title === historySheetName)?.properties;
  if (!sheet) {
    const created = await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: historySheetName, gridProperties: { frozenRowCount: 1, frozenColumnCount: 4 } } } }] },
    });
    sheet = created.data.replies[0].addSheet.properties;
  }
  const quotedSheet = `'${historySheetName.replaceAll("'", "''")}'`;
  const previous = await sheets.spreadsheets.values.get({ spreadsheetId, range: quotedSheet, valueRenderOption: "FORMATTED_VALUE" });
  const existing = previous.data.values || [];
  const plan = buildPriceHistory(existing, observations);
  const width = Math.max(plan.values[0].length, ...existing.map((row) => row.length));
  const height = Math.max(plan.values.length, existing.length);
  const requests = [];
  if (plan.migrating) {
    const base = `${historySheetName.slice(0, 55)} backup ${new Date().toISOString().replace(/[:.]/g, "-")}`;
    const titles = new Set((metadata.data.sheets || []).map((item) => item.properties?.title));
    let title = base, suffix = 2;
    while (titles.has(title)) title = `${base} ${suffix++}`;
    requests.push({ duplicateSheet: { sourceSheetId: sheet.sheetId, newSheetName: title } });
    console.log(`HISTORY Converting daily price columns; preserving original checks in ${title}`);
  }
  requests.push(
    { updateSheetProperties: { properties: { sheetId: sheet.sheetId, gridProperties: {
      rowCount: Math.max(sheet.gridProperties?.rowCount || 1000, height),
      columnCount: Math.max(sheet.gridProperties?.columnCount || 26, width),
      frozenRowCount: 1, frozenColumnCount: 4,
    } }, fields: "gridProperties.rowCount,gridProperties.columnCount,gridProperties.frozenRowCount,gridProperties.frozenColumnCount" } },
    { updateCells: {
      range: { sheetId: sheet.sheetId, startRowIndex: 0, endRowIndex: height, startColumnIndex: 0, endColumnIndex: width },
      rows: plan.values.map((row) => ({ values: row.map((value) => value === "" || value == null ? {} : {
        userEnteredValue: typeof value === "number" ? { numberValue: value } : { stringValue: String(value) },
      }) })),
      fields: "userEnteredValue",
    } },
    { repeatCell: { range: { sheetId: sheet.sheetId, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true }, numberFormat: { type: "TEXT", pattern: "@" } } }, fields: "userEnteredFormat.textFormat.bold,userEnteredFormat.numberFormat" } },
    { repeatCell: { range: { sheetId: sheet.sheetId, startColumnIndex: 0, endColumnIndex: 4 }, cell: { userEnteredFormat: { numberFormat: { type: "TEXT", pattern: "@" } } }, fields: "userEnteredFormat.numberFormat" } },
  );
  if (plan.values[0].length > 4) requests.push({ repeatCell: {
    range: { sheetId: sheet.sheetId, startRowIndex: 1, startColumnIndex: 4, endColumnIndex: plan.values[0].length },
    cell: { userEnteredFormat: { numberFormat: { type: "NUMBER", pattern: "€#,##0.00" } } }, fields: "userEnteredFormat.numberFormat",
  } });
  // Backup, conversion, grid growth, and values commit together in one atomic
  // Sheets batch. Strings use stringValue so retailer text cannot become formulas.
  await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
}

const overallColor = { red: 81 / 255, green: 172 / 255, blue: 183 / 255 };
const budgetColor = { red: 208 / 255, green: 155 / 255, blue: 230 / 255 };
const highlightMarker = "TV_CHECKER_HIGHLIGHT_";

export async function highlightBestModels(sheets, { spreadsheetId, sheetName }, best) {
  const metadata = await sheets.spreadsheets.get({ spreadsheetId, fields: "sheets(properties(sheetId,title),conditionalFormats)" });
  const sheet = metadata.data.sheets?.find((item) => item.properties?.title === sheetName);
  if (!sheet) throw new Error(`Sheet not found while highlighting: ${sheetName}`);
  const requests = [];
  // Delete only this checker's rules; user fills and unrelated rules are preserved.
  for (let index = (sheet.conditionalFormats || []).length - 1; index >= 0; index--) {
    if (sheet.conditionalFormats[index].booleanRule?.condition?.values?.some((value) => value.userEnteredValue?.includes(highlightMarker))) {
      requests.push({ deleteConditionalFormatRule: { sheetId: sheet.properties.sheetId, index } });
    }
  }
  const addRule = (product, label, format) => {
    if (!product) return;
    requests.push({ addConditionalFormatRule: { index: 0, rule: {
      ranges: [{ sheetId: sheet.properties.sheetId, startRowIndex: 1, startColumnIndex: 2, endColumnIndex: 3 }],
      booleanRule: { condition: { type: "CUSTOM_FORMULA", values: [{ userEnteredValue: `=AND(ROW()=${product.row},N("${highlightMarker}${label}")=0)` }] }, format },
    } } });
  };
  if (best.overall && best.overall.row === best.budget?.row) {
    addRule(best.overall, "BOTH", { backgroundColor: overallColor, textFormat: { foregroundColor: budgetColor, bold: true } });
  } else {
    addRule(best.overall, "OVERALL", { backgroundColor: overallColor });
    addRule(best.budget, "BUDGET", { backgroundColor: budgetColor });
  }
  if (requests.length) await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
}

export async function appendProducts(
  sheets,
  { spreadsheetId, sheetName },
  products,
  startRow,
) {
  if (!products.length) return;
  const quotedSheet = `'${sheetName.replaceAll("'", "''")}'`;
  const endRow = startRow + products.length - 1;
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${quotedSheet}!A${startRow}:L${endRow}`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      majorDimension: "ROWS",
      values: products.map((product) => [
        product.retailer,
        product.brand,
        product.model,
        product.year,
        product.url,
        euroNumber(product.price),
        product.stock,
        product.panelTechnology || "Not listed",
        product.refreshRate || "Not listed",
        product.os || "Not listed",
        product.vrr || "Not listed",
        product.hdmi21 || "Not listed",
      ]),
    },
  });

  const metadata = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets.properties(sheetId,title)",
  });
  const sheet = metadata.data.sheets?.find((item) => item.properties?.title === sheetName);
  if (!sheet) throw new Error(`Sheet not found while formatting appended rows: ${sheetName}`);
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          repeatCell: {
            range: { sheetId: sheet.properties.sheetId, startRowIndex: startRow - 1, endRowIndex: endRow, startColumnIndex: 5, endColumnIndex: 6 },
            cell: { userEnteredFormat: { numberFormat: { type: "NUMBER", pattern: "â‚¬#,##0.00" } } },
            fields: "userEnteredFormat.numberFormat",
          },
        },
        {
          repeatCell: {
            range: { sheetId: sheet.properties.sheetId, startRowIndex: startRow - 1, endRowIndex: endRow, startColumnIndex: 6, endColumnIndex: 7 },
            cell: { userEnteredFormat: { numberFormat: { type: "TEXT", pattern: "@" } } },
            fields: "userEnteredFormat.numberFormat",
          },
        },
      ],
    },
  });
}
