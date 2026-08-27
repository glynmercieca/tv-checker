import pLimit from "p-limit";
import { getConfig } from "./config.js";
import { createSheetsClient, readProducts, writeUpdates, appendProducts } from "./sheets.js";
import { maxSupportedRefreshRate, scrapeProduct } from "./scraper.js";
import { canonicalUrl, discoverCandidates, identityFromTitle, is85InchTelevisionTitle, listingKey } from "./discovery.js";
import { sendStatusEmail } from "./email.js";

export function meetsMinimumRefreshRate(value, minimumRefreshRateHz = 120) {
  const maximumRefreshRateHz = maxSupportedRefreshRate(value);
  return maximumRefreshRateHz != null && maximumRefreshRateHz >= minimumRefreshRateHz;
}

export async function runUpdater(overrides = {}) {
  const config = { ...getConfig(), ...overrides };
  const sheets = overrides.sheets || createSheetsClient();
  const summary = {
    checked: 0,
    modified: [],
    added: [],
    skipped: [],
    dryRun: config.dryRun,
    fatalError: null,
    completedAt: null,
  };
  let runError = null;

  try {
    const { products, nextRow } = await readProducts(sheets, config);
    summary.checked = products.length;
    const limit = pLimit(config.concurrency);
    console.log(`Checking ${products.length} products in ${config.sheetName}${config.dryRun ? " (dry run)" : ""}`);

    const existingResults = await Promise.all(products.map((product) => limit(async () => {
      try {
        const scraped = await scrapeProduct(product.url, config);
        const price = scraped.price ?? product.currentPrice;
        const stock = scraped.stock ?? product.currentStock;
        const changed = price !== product.currentPrice || stock !== product.currentStock;
        console.log(`${changed ? "CHANGE" : "OK    "} row ${product.row} ${product.retailer} ${product.model}: ${price || "—"} / ${stock || "—"} [${scraped.source}]`);
        return changed ? {
          row: product.row,
          retailer: product.retailer,
          model: product.model,
          beforePrice: product.currentPrice,
          beforeStock: product.currentStock,
          price,
          stock,
        } : null;
      } catch (error) {
        summary.skipped.push({ retailer: product.retailer, model: product.model, error: error.message });
        console.error(`SKIP   row ${product.row} ${product.retailer} ${product.model}: ${error.message}`);
        return null;
      }
    })));
    summary.modified = existingResults.filter(Boolean);

    if (config.discoveryEnabled) {
      const discovery = await discoverCandidates(config);
      summary.skipped.push(...discovery.errors);
      const existingUrls = new Set(products.map((product) => canonicalUrl(product.url)));
      const existingModels = new Set(products.map((product) => listingKey(product.retailer, product.model)));
      const newCandidates = discovery.candidates.filter((candidate) => !existingUrls.has(canonicalUrl(candidate.url)));
      const discoveredResults = await Promise.all(newCandidates.map((candidate) => limit(async () => {
        try {
          const scraped = await scrapeProduct(candidate.url, config);
          const title = scraped.title || candidate.title || "";
          if (!is85InchTelevisionTitle(title)) throw new Error(`Rejected candidate without an explicit 85-inch television title: ${title || "untitled page"}`);
          if (scraped.stock === "Listing unavailable") throw new Error("Candidate listing is unavailable");
          const refreshRate = scraped.specs?.refreshRate || "";
          if (!meetsMinimumRefreshRate(refreshRate, config.minimumRefreshRateHz)) {
            const detail = refreshRate
              ? `maximum verified refresh rate is ${refreshRate}`
              : "refresh rate could not be verified";
            throw new Error(`Rejected candidate: ${detail}; minimum is ${config.minimumRefreshRateHz} Hz`);
          }
          const identity = identityFromTitle(title);
          return {
            retailer: candidate.retailer,
            brand: identity.brand,
            model: identity.model,
            year: identity.year,
            url: candidate.url,
            price: scraped.price || "",
            stock: scraped.stock || "Unknown",
            panelTechnology: scraped.specs?.panelTechnology || "Not listed",
            refreshRate,
            os: scraped.specs?.os || "Not listed",
            vrr: scraped.specs?.vrr || "Not listed",
            hdmi21: scraped.specs?.hdmi21 || "Not listed",
          };
        } catch (error) {
          summary.skipped.push({ retailer: candidate.retailer, model: candidate.title || candidate.url, error: error.message });
          console.error(`SKIP   discovery ${candidate.retailer} ${candidate.url}: ${error.message}`);
          return null;
        }
      })));
      const additionsByModel = new Map();
      for (const item of discoveredResults.filter(Boolean)) {
        const key = listingKey(item.retailer, item.model);
        if (existingModels.has(key)) {
          console.log(`KNOWN  ${item.retailer} ${item.model}: model already exists under another URL`);
          continue;
        }
        if (!additionsByModel.has(key)) additionsByModel.set(key, item);
      }
      summary.added = [...additionsByModel.values()];
      if (summary.added.length > config.maxNewProducts) {
        throw new Error(`Discovery safety limit exceeded: validated ${summary.added.length} new listings (limit ${config.maxNewProducts})`);
      }
      summary.added.forEach((item) => console.log(`ADD    ${item.retailer} ${item.brand} ${item.model}: ${item.price || "—"} / ${item.stock}`));
    }

    if (!config.dryRun) {
      await writeUpdates(sheets, config, summary.modified);
      await appendProducts(sheets, config, summary.added, nextRow);
    }
    console.log(`${config.dryRun ? "Would modify" : "Modified"} ${summary.modified.length} row(s) and ${config.dryRun ? "would add" : "added"} ${summary.added.length} row(s).`);
  } catch (error) {
    runError = error;
    summary.fatalError = error.message;
    console.error(`FATAL  ${error.stack || error.message}`);
  }

  summary.completedAt = new Date().toISOString();
  try {
    await sendStatusEmail(summary, config);
  } catch (error) {
    console.error(`EMAIL  Failed: ${error.message}`);
    if (!runError) runError = new Error(`Update completed but status email failed: ${error.message}`);
  }
  if (runError) throw runError;
  return summary;
}
