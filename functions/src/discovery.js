import * as cheerio from "cheerio";

const sources = [
  {
    retailer: "Forestals",
    kind: "woo",
    baseUrl: "https://forestals.com",
  },
  {
    retailer: "The Atrium",
    kind: "sitemap",
    url: "https://www.theatrium.com.mt/sitemap.xml",
    requiredPath: "/electronics/televisions/",
  },
  {
    retailer: "Klikk",
    kind: "sitemap",
    url: "https://klikk.com.mt/sitemap-product.xml",
    requiredPath: "/product/",
  },
  {
    retailer: "Sound Machine",
    kind: "woo",
    baseUrl: "https://soundmachine.com.mt",
  },
  {
    retailer: "Scan Malta",
    kind: "magento",
    url: "https://www.scanmalta.com/shop/graphql",
    productBaseUrl: "https://www.scanmalta.com/shop/",
  },
  { retailer: "Audio Malta", kind: "woo", baseUrl: "https://www.audiomalta.com", userAgent: "Mozilla/5.0" },
  { retailer: "Digital Zone", kind: "woo", baseUrl: "https://digitalzone.com.mt", userAgent: "Mozilla/5.0" },
  { retailer: "Ultimate", kind: "category", url: "https://www.ultimate.com.mt/screen-size/85/", productPath: "/product/" },
  { retailer: "Telecom", kind: "category", url: "https://www.telecom.com.mt/en/shop/webshop/bycategory/186/name/asc/9/1/85-inch.htm", productPath: "/webshop/" },
];

export function retailerRequestOptions(url, config) {
  const host = new URL(url).hostname.replace(/^www\./, "");
  const source = sources.find((item) => new URL(item.baseUrl || item.productBaseUrl || item.url).hostname.replace(/^www\./, "") === host);
  return source?.userAgent ? { ...config, userAgent: source.userAgent } : config;
}

function decodeHtml(value) {
  return cheerio.load(String(value || "")).text().replace(/\s+/g, " ").trim();
}

export function is85InchTitle(title) {
  return /(?:^|\D)85\s*[-–]?\s*(?:inch(?:es)?\b|["″”])/i.test(decodeHtml(title));
}

export function is85InchTelevisionTitle(title) {
  const clean = decodeHtml(title);
  if (!is85InchTitle(clean)) return false;
  if (!/\b(?:tv|television)\b/i.test(clean)) return false;
  return !/\b(?:monitor|mount|bracket|stand|sync box|accessor|writing tablet|powerbank|motherboard|ssd|psu)\b/i.test(clean);
}

export function canonicalUrl(value) {
  const url = new URL(value);
  url.hash = "";
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_|gclid|fbclid)/i.test(key)) url.searchParams.delete(key);
  }
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.toString();
}

function looksLike85Url(value) {
  const decoded = decodeURIComponent(value).toLowerCase();
  return /(?:^|[-_/])85(?:[-_/]|inch|″|%22|[a-z][a-z0-9-]{1,})|[a-z]{1,5}85[a-z0-9-]{2,}/i.test(decoded);
}

async function fetchText(url, config, init = {}) {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(config.requestTimeoutMs),
    headers: {
      "user-agent": config.userAgent,
      accept: "*/*",
      ...(init.headers || {}),
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
  return response.text();
}

async function discoverSitemap(source, config) {
  const pending = [source.url], visited = new Set(), found = [];
  while (pending.length) {
    const url = pending.shift();
    if (visited.has(url)) continue;
    if (visited.size >= (config.maxDiscoveryPages || 20)) throw new Error("Sitemap page limit exceeded");
    visited.add(url);
    const $ = cheerio.load(await fetchText(url, config), { xmlMode: true });
    if (!$("sitemapindex, urlset").length) throw new Error("Retailer did not return a valid sitemap");
    $("sitemap > loc").each((_, element) => {
      const child = new URL($(element).text().trim(), url);
      if (child.origin === new URL(source.url).origin) pending.push(child.toString());
    });
    $("url > loc").each((_, element) => {
      const productUrl = $(element).text().trim();
      if (new URL(productUrl).origin !== new URL(source.url).origin) return;
      if ((!source.requiredPath || new URL(productUrl).pathname.includes(source.requiredPath)) && looksLike85Url(productUrl)) {
        found.push({ retailer: source.retailer, url: productUrl });
      }
    });
  }
  return found;
}

async function discoverWoo(source, config) {
  const api = new URL("/wp-json/wc/store/v1", source.baseUrl);
  const discovered = [];
  const pageLimit = config.maxDiscoveryPages || 20;
  for (let page = 1; page <= pageLimit; page += 1) {
      const productsUrl = new URL(`${api}/products`);
      // Search all categories: local shops use both TV and television taxonomies.
      productsUrl.searchParams.set("search", "85");
      productsUrl.searchParams.set("per_page", "100");
      if (page > 1) productsUrl.searchParams.set("page", String(page));
      const products = JSON.parse(await fetchText(productsUrl, config, { headers: { "user-agent": source.userAgent || config.userAgent } }));
      if (!Array.isArray(products)) throw new Error("Retailer returned an invalid product catalog");
      for (const product of products) {
        const title = decodeHtml(product.name);
        if (is85InchTelevisionTitle(title)) {
          discovered.push({ retailer: source.retailer, url: product.permalink, title });
        }
      }
      if (products.length < 100) break;
      if (page === pageLimit) throw new Error("Catalog page limit exceeded");
  }
  return discovered;
}

async function discoverCategory(source, config) {
  const pending = [source.url], visited = new Set(), found = [];
  while (pending.length) {
    const url = pending.shift();
    if (visited.has(url)) continue;
    if (visited.size >= (config.maxDiscoveryPages || 20)) throw new Error("Category page limit exceeded");
    visited.add(url);
    const $ = cheerio.load(await fetchText(url, config));
    if (/verify you are human|just a moment|checking your browser/i.test($("title, body").text().slice(0, 2000))) {
      throw new Error("Retailer returned an anti-bot verification page");
    }
    $("a[href]").each((_, element) => {
      const link = $(element);
      const target = new URL(link.attr("href"), url);
      if (target.origin !== new URL(source.url).origin) return;
      const title = decodeHtml(link.find("h2, h3").text() || link.text() || link.attr("title") || link.find("img").attr("alt"));
      if (target.pathname.includes(source.productPath) && !target.pathname.includes("/bycategory/") &&
          (is85InchTelevisionTitle(title) || looksLike85Url(target.toString()))) {
        target.hash = "";
        if (![...target.searchParams.keys()].some((key) => /add-to-cart/i.test(key))) {
          found.push({ retailer: source.retailer, url: target.toString(), title });
        }
      }
      if (link.is(".next, [rel='next']")) pending.push(target.toString());
    });
  }
  return found;
}

async function discoverMagento(source, config) {
  const query = `query Discover85InchTVs {
    products(search: "85", pageSize: 200) {
      items { name url_key categories { name } }
    }
  }`;
  const response = JSON.parse(
    await fetchText(source.url, config, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query }),
    }),
  );
  if (response.errors?.length) throw new Error(response.errors.map((error) => error.message).join("; "));
  return (response.data?.products?.items || [])
    .filter((product) => product.categories?.some((category) => /televisions?/i.test(category.name)))
    .filter((product) => is85InchTelevisionTitle(product.name))
    .map((product) => ({
      retailer: source.retailer,
      title: decodeHtml(product.name),
      url: new URL(`${product.url_key}.html`, source.productBaseUrl).toString(),
    }));
}

export async function discoverCandidates(config) {
  const candidates = [];
  const errors = [];
  for (const source of sources) {
    try {
      const found = source.kind === "woo"
        ? await discoverWoo(source, config)
        : source.kind === "magento"
          ? await discoverMagento(source, config)
          : source.kind === "category"
            ? await discoverCategory(source, config)
            : await discoverSitemap(source, config);
      candidates.push(...found);
      console.log(`DISCOVER ${source.retailer}: ${found.length} candidate 85-inch listing(s)`);
    } catch (error) {
      errors.push({ retailer: source.retailer, error: `Discovery failed: ${error.message}` });
      console.error(`DISCOVER ${source.retailer}: ${error.message}`);
    }
  }

  const unique = new Map();
  for (const candidate of candidates) unique.set(canonicalUrl(candidate.url), candidate);
  return { candidates: [...unique.values()], errors };
}

const brands = [
  "Samsung", "Hisense", "TCL", "Sony", "Philips", "LG", "Xiaomi", "Panasonic",
  "Sharp", "Toshiba", "JVC", "Grundig", "Haier", "Metz", "Next",
];

export function identityFromTitle(title) {
  const clean = decodeHtml(title).replace(/\s*[|–-]\s*(?:Forestals|SCAN|Klikk|Sound Machine|The Atrium).*$/i, "").trim();
  const brand = brands.find((candidate) => new RegExp(`\\b${candidate}\\b`, "i").test(clean)) || "";
  const modelMatches = clean.match(/\b(?:[A-Z]{1,6}-?)?85[A-Z0-9-]{2,}\b/gi) || [];
  const model = modelMatches.find((candidate) => !/^85(?:INCH|TV)$/i.test(candidate)) || clean;
  const year = clean.match(/\b20(?:2[4-9]|3\d)\b/)?.[0] || "";
  return { brand, model, year, title: clean };
}

export function listingKey(retailer, model) {
  const cleanModel = decodeHtml(model).toUpperCase();
  const token = cleanModel.match(/\b(?:[A-Z]{1,6}-?)?85[A-Z0-9-]{2,}\b/)?.[0] || cleanModel;
  return `${decodeHtml(retailer).toUpperCase()}|${token.replace(/[^A-Z0-9]/g, "")}`;
}

export const testing = { decodeHtml, looksLike85Url, discoverSitemap, discoverCategory, discoverWoo };
