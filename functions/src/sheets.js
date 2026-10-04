import { google } from "googleapis";
import { priceNumber } from "./ranking.js";

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

export async function readProducts(sheets, { spreadsheetId, sheetName }) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${sheetName.replaceAll("'", "''")}'!A2:V`,
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

const historyHeaders = ["Checked at (UTC)", "Retailer", "Brand", "Model", "Product link", "Price (€)", "Stock", "Check status"];

export async function appendPriceHistory(sheets, config, observations) {
  const { spreadsheetId, sheetName, historySheetName = "Price history" } = config;
  if (historySheetName === sheetName) throw new Error("Price history must use a separate sheet");
  const metadata = await sheets.spreadsheets.get({ spreadsheetId, fields: "sheets.properties(sheetId,title)" });
  let sheet = metadata.data.sheets?.find((item) => item.properties?.title === historySheetName)?.properties;
  if (!sheet) {
    const created = await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: historySheetName, gridProperties: { frozenRowCount: 1 } } } }] },
    });
    sheet = created.data.replies[0].addSheet.properties;
  }
  const range = `'${historySheetName.replaceAll("'", "''")}'`;
  const header = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${range}!A1:H1` });
  if (header.data.values?.[0]?.some(Boolean)) {
    if (JSON.stringify(header.data.values[0]) !== JSON.stringify(historyHeaders)) {
      throw new Error(`Unexpected headers in history sheet: ${historySheetName}`);
    }
  } else {
    await sheets.spreadsheets.values.update({ spreadsheetId, range: `${range}!A1:H1`, valueInputOption: "RAW", requestBody: { values: [historyHeaders] } });
  }
  if (observations.length) {
    await sheets.spreadsheets.values.append({
      spreadsheetId, range: `${range}!A:H`, valueInputOption: "RAW", insertDataOption: "INSERT_ROWS",
      requestBody: { values: observations.map((item) => [
        item.checkedAt, item.retailer, item.brand, item.model, item.url,
        euroNumber(item.price), item.stock || "Unknown", item.error ? `Failed: ${item.error}` : "Checked",
      ]) },
    });
  }
  await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: [
    { repeatCell: { range: { sheetId: sheet.sheetId, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: "userEnteredFormat.textFormat.bold" } },
    { repeatCell: { range: { sheetId: sheet.sheetId, startRowIndex: 1, startColumnIndex: 5, endColumnIndex: 6 }, cell: { userEnteredFormat: { numberFormat: { type: "NUMBER", pattern: "€#,##0.00" } } }, fields: "userEnteredFormat.numberFormat" } },
  ] } });
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
            cell: { userEnteredFormat: { numberFormat: { type: "NUMBER", pattern: "€#,##0.00" } } },
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
