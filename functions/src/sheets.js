import { google } from "googleapis";

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
  const amount = Number(String(value || "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(amount) && amount > 0 ? amount : "";
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
