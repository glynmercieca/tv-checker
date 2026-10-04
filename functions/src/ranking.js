import { maxSupportedRefreshRate } from "./scraper.js";

export function priceNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : null;
  let amount = String(value || "").replace(/€|EUR|euros?/gi, "").replace(/\s/g, "");
  if (/^\d{1,3}(?:\.\d{3})*,\d{2}$/.test(amount) || /^\d+,\d{2}$/.test(amount)) {
    amount = amount.replace(/\./g, "").replace(",", ".");
  } else if (/^\d{1,3}(?:,\d{3})+(?:\.\d{2})?$/.test(amount)) amount = amount.replace(/,/g, "");
  if (!/^\d+(?:\.\d{1,2})?$/.test(amount)) return null;
  const result = Number(amount);
  return Number.isFinite(result) && result > 0 ? result : null;
}

export function isInStock(value) {
  return /^(?:in stock(?:\s*\([^)]*\))?|low stock)$/i.test(String(value || "").trim());
}

function panelRank(value) {
  const panel = String(value || "");
  if (/\bOLED\b/i.test(panel)) return 5;
  if (/RGB.*Mini\s*[- ]?LED/i.test(panel)) return 4;
  if (/Mini\s*[- ]?LED|Neo QLED/i.test(panel)) return 3;
  if (/QLED|QNED/i.test(panel)) return 2;
  if (/\bLED\b|LCD|DLED/i.test(panel)) return 1;
  return 0;
}

export function selectBestModels(products, { minimumRefreshRateHz = 120, budgetLimit = 1200 } = {}) {
  const ranked = products.filter((product) => isInStock(product.stock) &&
    maxSupportedRefreshRate(product.refreshRate) >= Math.max(120, minimumRefreshRateHz) &&
    panelRank(product.panelTechnology) > 0);
  const score = (product) => [
    panelRank(product.panelTechnology), maxSupportedRefreshRate(product.refreshRate),
    /^yes$/i.test(product.vrr || "") ? 1 : 0,
    /^yes$/i.test(product.hdmi21 || "") ? 1 : 0,
    /Google TV/i.test(product.os || "") ? 1 : 0,
  ];
  ranked.sort((a, b) => {
    const aScore = score(a), bScore = score(b);
    for (let i = 0; i < aScore.length; i++) if (aScore[i] !== bScore[i]) return bScore[i] - aScore[i];
    return (priceNumber(a.price) ?? Infinity) - (priceNumber(b.price) ?? Infinity) || a.row - b.row;
  });
  return {
    overall: ranked[0] || null,
    budget: ranked.find((product) => priceNumber(product.price) != null && priceNumber(product.price) < budgetLimit) || null,
  };
}
