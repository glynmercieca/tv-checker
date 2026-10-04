import { canonicalUrl, listingKey } from "./discovery.js";
import { priceNumber } from "./ranking.js";

export const historyHeaders = ["Retailer", "Brand", "Model", "Product link"];
const legacyHeaders = ["Checked at (UTC)", "Retailer", "Brand", "Model", "Product link", "Price (€)", "Stock", "Check status"];

function historyKey(retailer, brand, model, url) {
  return JSON.stringify([String(brand || "").trim().toUpperCase(),
    model ? listingKey(retailer, model) : `${String(retailer || "").toUpperCase()}|${canonicalUrl(url)}`]);
}

export function historyDate(checkedAt) {
  const date = new Date(checkedAt);
  if (!checkedAt || !Number.isFinite(date.getTime())) throw new Error(`Invalid history check timestamp: ${checkedAt}`);
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en", {
    timeZone: "Europe/Malta", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function validDateHeader(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

export function buildPriceHistory(existing, observations) {
  const header = existing[0] || [];
  const migrating = JSON.stringify(header) === JSON.stringify(legacyHeaders);
  const hasData = existing.some((row) => row.some((value) => value !== "" && value != null));
  const isWide = header.slice(0, 4).every((value, index) =>
    String(value).trim().toLowerCase() === historyHeaders[index].toLowerCase()) && header.length >= 4;
  if (hasData && !migrating && !isWide) throw new Error("Unexpected headers in history sheet");
  const dates = new Set();
  const products = new Map();
  if (isWide) {
    for (const value of header.slice(4)) {
      if (!validDateHeader(value) || dates.has(value)) throw new Error("History date headers must be unique YYYY-MM-DD dates");
      dates.add(value);
    }
    for (const row of existing.slice(1)) {
      if (!row.some((value) => value !== "" && value != null)) continue;
      if (!/^https?:\/\//i.test(row[3] || "") || row.length > header.length) throw new Error("Invalid existing history product row");
      const key = historyKey(row[0], row[1], row[2], row[3]);
      if (products.has(key)) throw new Error("Duplicate retailer/model rows in history sheet");
      const prices = new Map();
      for (let column = 4; column < row.length; column++) {
        if (row[column] === "" || row[column] == null) continue;
        const price = priceNumber(row[column]);
        if (price == null) throw new Error(`Invalid existing history price in ${header[column]}`);
        prices.set(header[column], price);
      }
      products.set(key, { identity: row.slice(0, 4), prices });
    }
  }
  const legacy = migrating ? existing.slice(1).filter((row) => row.some(Boolean)).map((row) => ({
    checkedAt: row[0], retailer: row[1], brand: row[2], model: row[3], url: row[4], price: row[5],
    error: /^Failed:/i.test(row[7] || "") ? row[7] : null,
  })) : [];
  // The latest successful observation on a Malta calendar day wins. A later
  // failure/unknown price never erases a price already verified that day.
  const incoming = [...legacy, ...observations].sort((a, b) => new Date(a.checkedAt) - new Date(b.checkedAt));
  for (const item of incoming) {
    const date = historyDate(item.checkedAt);
    if (!/^https?:\/\//i.test(item.url || "")) throw new Error("History observation requires a product link");
    dates.add(date);
    const key = historyKey(item.retailer, item.brand, item.model, item.url);
    let product = products.get(key);
    if (!product) {
      product = { identity: [item.retailer || "", item.brand || "", item.model || "", item.url], prices: new Map() };
      products.set(key, product);
    } else if (!item.error) {
      product.identity = [item.retailer || "", item.brand || "", item.model || "", item.url];
    }
    const price = item.error ? null : priceNumber(item.price);
    if (price != null) product.prices.set(date, price);
  }
  const dateColumns = [...dates].sort();
  return {
    migrating,
    values: [[...historyHeaders, ...dateColumns], ...[...products.values()].map((product) => [
      ...product.identity, ...dateColumns.map((date) => product.prices.get(date) ?? ""),
    ])],
  };
}
