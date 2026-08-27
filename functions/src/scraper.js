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

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function specificationPairs($) {
  const pairs = [];
  $("table tr").each((_, row) => {
    const cells = $(row).find("th, td").map((__, cell) => cleanText($(cell).text())).get();
    if (cells.length >= 2 && cells[0] && cells.at(-1)) pairs.push([cells[0], cells.at(-1)]);
  });
  $("dt").each((_, term) => {
    const value = cleanText($(term).next("dd").text());
    if (value) pairs.push([cleanText($(term).text()), value]);
  });
  return pairs;
}

function labelledValue(pairs, pattern) {
  return pairs.find(([label]) => pattern.test(label))?.[1] || "";
}

function normalizePanel(value) {
  const match = cleanText(value).match(
    /\b(?:SQD[- ]?Mini\s*LED|QD[- ]?Mini\s*LED|Mini\s*LED|QD[- ]?OLED|OLED|QLED|Direct\s*LED|DLED|Edge\s*LED|LED\s*LCD|LCD)\b/i,
  )?.[0];
  if (!match) return "";
  return match
    .replace(/sqd[- ]?mini\s*led/i, "SQD-Mini LED")
    .replace(/qd[- ]?mini\s*led/i, "QD-Mini LED")
    .replace(/mini\s*led/i, "Mini LED")
    .replace(/qd[- ]?oled/i, "QD-OLED")
    .replace(/direct\s*led/i, "Direct LED")
    .replace(/edge\s*led/i, "Edge LED")
    .replace(/led\s*lcd/i, "LED LCD")
    .toUpperCase()
    .replace("DIRECT LED", "Direct LED")
    .replace("EDGE LED", "Edge LED")
    .replace("MINI LED", "Mini LED");
}

export function maxSupportedRefreshRate(value) {
  const clean = cleanText(value);
  const rates = [...clean.matchAll(/\b(\d{2,3})\s*hz\b/gi)]
    .filter((match) => {
      const prefix = clean.slice(Math.max(0, match.index - 32), match.index);
      return !/(?:motion rate|motionflow|clear motion|tru\s*motion|pqi)\s*$/i.test(prefix);
    })
    .map((match) => Number(match[1]))
    .filter((rate) => Number.isFinite(rate));
  return rates.length ? Math.max(...rates) : null;
}

function normalizeRefreshRate(...values) {
  const rate = maxSupportedRefreshRate(values.join(" "));
  return rate == null ? "" : `${rate} Hz`;
}

function normalizeOs(value) {
  const clean = cleanText(value);
  if (/\bGoogle TV\b/i.test(clean)) return "Google TV";
  if (/\bAndroid TV\b/i.test(clean)) return "Android TV";
  if (/\bTitan OS\b/i.test(clean)) return "Titan OS";
  if (/\bVIDAA\b/i.test(clean)) return "VIDAA";
  if (/\bwebOS\b/i.test(clean)) return "webOS";
  if (/\bTizen\b/i.test(clean)) return "Tizen";
  if (/\bRoku TV\b/i.test(clean)) return "Roku TV";
  if (/\bFire TV\b/i.test(clean)) return "Fire TV";
  return "";
}

function normalizeSupport(value, positivePattern) {
  const clean = cleanText(value);
  if (/\b(?:no|not supported|none)\b/i.test(clean)) return "No";
  if (/\b(?:yes|supported|available)\b/i.test(clean) || positivePattern.test(clean)) return "Yes";
  return "";
}

function extractTechnicalSpecs($, products, bodyText) {
  const pairs = specificationPairs($);
  const structuredText = products.flatMap((product) => [
    product.name,
    product.description,
    ...arrays(product.additionalProperty).flatMap((property) => [property?.name, property?.value]),
  ]).join(" ");
  const focusedText = cleanText($(
    ".woocommerce-product-details__short-description, .woocommerce-Tabs-panel, .product-info-main, .product-detail, main",
  ).text());
  const sourceText = cleanText(`${structuredText} ${focusedText || bodyText}`);

  const panelValue = labelledValue(
    pairs,
    /\b(?:panel|display|screen)\s*(?:technology|type)\b|\bpanel\b/i,
  );
  const refreshValue = labelledValue(pairs, /\b(?:native\s*)?refresh\s*rate\b|\bfrequency\b/i);
  const osValue = labelledValue(pairs, /\boperating system\b|\bsmart\s*(?:tv\s*)?(?:platform|os)\b|^os$/i);
  const vrrValue = labelledValue(pairs, /\b(?:vrr|variable refresh rate)\b/i);
  const hdmiValue = labelledValue(pairs, /\bhdmi\s*(?:version|2[.]1)\b/i);

  return {
    panelTechnology: normalizePanel(panelValue) || normalizePanel(sourceText),
    refreshRate: normalizeRefreshRate(refreshValue, sourceText),
    os: normalizeOs(osValue) || normalizeOs(sourceText),
    vrr: normalizeSupport(vrrValue, /\b(?:vrr|variable refresh rate|free\s*sync|g-sync)\b/i) ||
      (/\b(?:vrr|variable refresh rate|free\s*sync|g-sync)\b/i.test(sourceText) ? "Yes" : ""),
    hdmi21: normalizeSupport(hdmiValue, /\bhdmi\s*2[.]1\b/i) ||
      (/\bhdmi\s*2[.]1\b/i.test(sourceText) ? "Yes" : ""),
  };
}

function withTechnicalSpecs(result, specs) {
  return Object.values(specs).some(Boolean) ? { ...result, specs } : result;
}

function parseDocument(html) {
  const $ = cheerio.load(html);
  const bodyText = $("body").text().replace(/\s+/g, " ").trim();
  if (blockedPage.test(bodyText.slice(0, 2_000))) {
    throw new Error("Retailer returned an anti-bot verification page");
  }

  const products = jsonLdProducts($);
  const specs = extractTechnicalSpecs($, products, bodyText);
  for (const product of products) {
    const offers = offerCandidates(product);
    const availableOffer = offers.find((offer) => stockFromAvailability(offer.availability) === "In stock");
    const offer = availableOffer || offers[0];
    const price = formatEuro(offer?.price ?? offer?.lowPrice);
    const stock = stockFromAvailability(offer?.availability) || stockFromText(product.name || "");
    if (price || stock) {
      return withTechnicalSpecs({
        price,
        stock,
        title: String(product.name || "").replace(/\s+/g, " ").trim() || null,
        source: "JSON-LD",
      }, specs);
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
  return withTechnicalSpecs({ price, stock, title, source: "page markup" }, specs);
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
  const detailHtml = `<main><h1>${product.name || ""}</h1>${product.short_description || ""}${product.description || ""}</main>`;
  const $ = cheerio.load(detailHtml);
  const specs = extractTechnicalSpecs($, [], $("body").text());
  return withTechnicalSpecs({
    price,
    stock,
    title: cheerio.load(String(product.name || "")).text().trim() || null,
    source: "Woo Store API",
  }, specs);
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

export const testing = { extractTechnicalSpecs, parseDocument, stockFromAvailability, stockFromText };
