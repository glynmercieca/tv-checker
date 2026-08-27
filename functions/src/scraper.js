import * as cheerio from "cheerio";

const unavailablePage = /(?:product|item)\s+(?:not found|no longer available)|listing unavailable/i;
const blockedPage = /checking your browser|verify you are human|just a moment|request is being verified/i;

function arrays(value) {
  return value == null ? [] : Array.isArray(value) ? value : [value];
}

function jsonLdProducts($) {
  const nodes = [];
  $('script[type="application/ld+json"]').each((_, element) => {
    try {
      const parsed = JSON.parse($(element).text());
      const visit = (value) => {
        if (!value || typeof value !== "object") return;
        if (arrays(value["@type"]).some((type) => String(type).toLowerCase() === "product")) {
          nodes.push(value);
        }
        arrays(value["@graph"]).forEach(visit);
      };
      arrays(parsed).forEach(visit);
    } catch {
      // Some sites emit malformed analytics JSON-LD. Ignore it and continue.
    }
  });
  return nodes;
}

function asAmount(value) {
  if (typeof value === "number") return value;
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const normalized = raw
    .replace(/[^\d.,-]/g, "")
    .replace(/,(?=\d{3}(?:\D|$))/g, "");
  const amount = Number(normalized.replace(",", "."));
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

export function formatEuro(value) {
  const amount = asAmount(value);
  return amount == null
    ? null
    : new Intl.NumberFormat("en-IE", {
        style: "currency",
        currency: "EUR",
        minimumFractionDigits: 2,
      }).format(amount);
}

function stockFromAvailability(value) {
  const availability = String(value || "").split("/").pop().toLowerCase();
  if (/outofstock|soldout/.test(availability)) return "Out of stock";
  if (/instock|limitedavailability/.test(availability)) return "In stock";
  if (/preorder|presale/.test(availability)) return "Pre-order";
  if (/discontinued/.test(availability)) return "Listing unavailable";
  return null;
}

function stockFromText(text) {
  const clean = text.replace(/\s+/g, " ");
  const quantity = clean.match(/\b(\d+)\s+(?:items?\s+)?available\b/i);
  if (quantity) return `In stock (${quantity[1]} available)`;
  if (/\bpre[- ]?order\b/i.test(clean)) return "Pre-order";
  if (/\bonline only\b/i.test(clean) && /\bin stock|available\b/i.test(clean)) {
    return "In stock (online only)";
  }
  if (/\blow stock|only a few left\b/i.test(clean)) return "Low stock";
  if (/\bcurrently not available\b|\bout of stock\b|\bsold out\b/i.test(clean)) {
    return "Out of stock";
  }
  if (/\bin stock\b|\bavailable for (?:order|delivery)\b/i.test(clean)) return "In stock";
  return null;
}

function offerCandidates(product) {
  const candidates = [];
  for (const offer of arrays(product?.offers)) {
    if (offer?.price != null) candidates.push(offer);
    for (const nested of arrays(offer?.offers)) candidates.push(nested);
  }
  return candidates;
}

function parseDocument(html) {
  const $ = cheerio.load(html);
  const bodyText = $("body").text().replace(/\s+/g, " ").trim();
  if (blockedPage.test(bodyText.slice(0, 2_000))) {
    throw new Error("Retailer returned an anti-bot verification page");
  }

  for (const product of jsonLdProducts($)) {
    const offers = offerCandidates(product);
    const availableOffer = offers.find((offer) => stockFromAvailability(offer.availability) === "In stock");
    const offer = availableOffer || offers[0];
    const price = formatEuro(offer?.price ?? offer?.lowPrice);
    const stock = stockFromAvailability(offer?.availability) || stockFromText(product.name || "");
    if (price || stock) {
      return {
        price,
        stock,
        title: String(product.name || "").replace(/\s+/g, " ").trim() || null,
        source: "JSON-LD",
      };
    }
  }

  // Check this after structured data: some valid store templates contain a hidden
  // generic "Product Not Found" modal even when the current product is available.
  if (unavailablePage.test(bodyText)) {
    return { price: "", stock: "Listing unavailable", title: null, source: "page status" };
  }

  const metaPrice =
    $('meta[property="product:price:amount"]').attr("content") ||
    $('meta[property="og:price:amount"]').attr("content") ||
    $('[itemprop="price"]').first().attr("content");
  const localPriceText = $(
    '[id$="PanelPrice"], .product-info-main .price, .product-info .price, .summary .price, .product-detail .price',
  )
    .first()
    .text();
  const localPrice = localPriceText.match(/€\s*([\d,.]+)/)?.[1];
  const price = formatEuro(metaPrice || localPrice);

  const focusedText = $(
    ".product-info-main, .summary, .product-info, .product-detail, .product-single, main",
  )
    .first()
    .text();
  const explicitStockText = $(
    ".stock.available, .stock.unavailable, .availability, [class*=stock-status], [id$=PanelCart]",
  )
    .first()
    .text();
  const stock =
    stockFromAvailability($('link[itemprop="availability"]').attr("href")) ||
    stockFromText(explicitStockText) ||
    stockFromText(focusedText);

  if (!price && !stock) throw new Error("Could not confidently locate price or stock");
  const title = $("h1").first().text().replace(/\s+/g, " ").trim() ||
    $("title").text().split("|")[0].replace(/\s+/g, " ").trim() || null;
  return { price, stock, title, source: "page markup" };
}

async function fetchHtml(url, { userAgent, requestTimeoutMs }) {
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(requestTimeoutMs),
    headers: {
      "user-agent": userAgent,
      accept: "text/html,application/xhtml+xml",
      "accept-language": "en-GB,en;q=0.9",
    },
  });
  if (response.status === 404 || response.status === 410) {
    return { unavailable: true, html: "" };
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return { unavailable: false, html: await response.text() };
}

async function tryWooStoreApi(url, options) {
  const target = new URL(url);
  const slug = target.pathname.split("/").filter(Boolean).pop();
  const api = new URL("/wp-json/wc/store/v1/products", target.origin);
  api.searchParams.set("slug", slug);
  const response = await fetch(api, {
    signal: AbortSignal.timeout(options.requestTimeoutMs),
    headers: { "user-agent": options.userAgent, accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Woo Store API HTTP ${response.status}`);
  const [product] = await response.json();
  if (!product) return { price: "", stock: "Listing unavailable", title: null, source: "Woo Store API" };
  const minorUnit = Number(product.prices?.currency_minor_unit ?? 2);
  const rawPrice = Number(product.prices?.price);
  const price = Number.isFinite(rawPrice) ? formatEuro(rawPrice / 10 ** minorUnit) : null;
  const stock = product.is_in_stock === true ? "In stock" : product.is_in_stock === false ? "Out of stock" : null;
  return {
    price,
    stock,
    title: cheerio.load(String(product.name || "")).text().trim() || null,
    source: "Woo Store API",
  };
}

export async function scrapeProduct(url, options) {
  try {
    const result = await fetchHtml(url, options);
    if (result.unavailable) return { price: "", stock: "Listing unavailable", title: null, source: "HTTP status" };
    return parseDocument(result.html);
  } catch (pageError) {
    try {
      return await tryWooStoreApi(url, options);
    } catch (apiError) {
      throw new Error(`${pageError.message}; fallback failed: ${apiError.message}`);
    }
  }
}

export const testing = { parseDocument, stockFromAvailability, stockFromText };
