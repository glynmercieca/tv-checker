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
];

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
  return /(?:^|[-_/])85(?:[-_/]|inch|″|%22)|[a-z]{1,5}85[a-z0-9-]{2,}/i.test(decoded);
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
  const xml = await fetchText(source.url, config);
  const $ = cheerio.load(xml, { xmlMode: true });
  return $("loc")
    .map((_, element) => $(element).text().trim())
    .get()
    .filter((url) => (!source.requiredPath || new URL(url).pathname.includes(source.requiredPath)))
    .filter(looksLike85Url)
    .map((url) => ({ retailer: source.retailer, url }));
}

async function discoverWoo(source, config) {
  const api = new URL("/wp-json/wc/store/v1", source.baseUrl);
  const categoriesUrl = new URL(`${api}/products/categories`);
  categoriesUrl.searchParams.set("search", "television");
  categoriesUrl.searchParams.set("per_page", "100");
  const categories = JSON.parse(await fetchText(categoriesUrl, config));
  const televisionCategories = categories.filter((category) =>
    /televisions?/i.test(`${decodeHtml(category.name)} ${category.slug}`),
  );
  const discovered = [];

  for (const category of televisionCategories) {
    const pageCount = Math.max(1, Math.ceil(Number(category.count || 1) / 100));
    for (let page = 1; page <= pageCount; page += 1) {
      const productsUrl = new URL(`${api}/products`);
      productsUrl.searchParams.set("category", String(category.id));
      productsUrl.searchParams.set("per_page", "100");
      productsUrl.searchParams.set("page", String(page));
      const products = JSON.parse(await fetchText(productsUrl, config));
      for (const product of products) {
        const title = decodeHtml(product.name);
        if (is85InchTelevisionTitle(title)) {
          discovered.push({ retailer: source.retailer, url: product.permalink, title });
        }
      }
    }
  }
  return discovered;
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
  "Sharp", "Toshiba", "JVC", "Grundig", "Haier", "Metz",
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

export const testing = { decodeHtml, looksLike85Url };
