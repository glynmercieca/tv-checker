import pLimit from "p-limit";
import { getConfig } from "./config.js";
import { createSheetsClient, resolveProductSheet, readProducts, writeUpdates, appendProducts, writeSpecifications, appendPriceHistory, highlightBestModels } from "./sheets.js";
import { selectBestModels } from "./ranking.js";
import { maxSupportedRefreshRate, scrapeProduct } from "./scraper.js";
import { canonicalUrl, discoverCandidates, identityFromTitle, is85InchTelevisionTitle, is85InchTitle, listingKey, retailerRequestOptions } from "./discovery.js";
import { sendStatusEmail } from "./email.js";

export function meetsMinimumRefreshRate(value, minimumRefreshRateHz = 120) {
  const maximumRefreshRateHz = maxSupportedRefreshRate(value);
  return maximumRefreshRateHz != null && maximumRefreshRateHz >= minimumRefreshRateHz;
}

export async function runUpdater(overrides = {}) {
  const config = { ...getConfig(), ...overrides };
  const sheets = overrides.sheets || createSheetsClient();
  const scrape = overrides.scrapeProduct || scrapeProduct;
  const discover = overrides.discoverCandidates || discoverCandidates;
  const sendEmail = overrides.sendStatusEmail || sendStatusEmail;
  const observations = [];
  const summary = {
    checked: 0,
    modified: [],
    added: [],
    skipped: [],
    dryRun: config.dryRun,
    fatalError: null,
    completedAt: null,
    best: { overall: null, budget: null },
    historyCount: 0,
    specificationsUpdated: 0,
  };
  let runError = null;

  try {
    config.sheetName = await resolveProductSheet(sheets, config);
    if (config.sheetName === config.historySheetName) throw new Error("Product and price-history tabs must have different names");
    const { products, nextRow } = await readProducts(sheets, config);
    summary.checked = products.length;
    const limit = pLimit(config.concurrency);
    console.log(`Checking ${products.length} products in ${config.sheetName}${config.dryRun ? " (dry run)" : ""}`);

    const existingResults = await Promise.all(products.map((product) => limit(async () => {
      try {
        const scraped = await scrape(product.url, retailerRequestOptions(product.url, config));
        const observation = { ...product, checkedAt: new Date().toISOString(), price: scraped.price, stock: scraped.stock };
        const current = { ...product, price: scraped.price, stock: scraped.stock };
        for (const field of ["panelTechnology", "refreshRate", "os", "vrr", "hdmi21"]) {
          current[field] = scraped.specs?.[field] || product[field] || "Not listed";
        }
        const specsChanged = ["panelTechnology", "refreshRate", "os", "vrr", "hdmi21"]
          .some((field) => scraped.specs?.[field] && current[field] !== product[field]);
        const price = scraped.price ?? product.currentPrice;
        const stock = scraped.stock ?? product.currentStock;
        const changed = price !== product.currentPrice || stock !== product.currentStock;
        console.log(`${changed ? "CHANGE" : "OK    "} row ${product.row} ${product.retailer} ${product.model}: ${price || "—"} / ${stock || "—"} [${scraped.source}]`);
        return { observation, current, specsChanged, update: changed ? {
          row: product.row,
          retailer: product.retailer,
          model: product.model,
          beforePrice: product.currentPrice,
          beforeStock: product.currentStock,
          price,
          stock,
        } : null };
      } catch (error) {
        summary.skipped.push({ retailer: product.retailer, model: product.model, error: error.message });
        console.error(`SKIP   row ${product.row} ${product.retailer} ${product.model}: ${error.message}`);
        return { observation: { ...product, checkedAt: new Date().toISOString(), price: null, stock: null, error: error.message } };
      }
    })));
    observations.push(...existingResults.map((result) => result.observation));
    summary.modified = existingResults.map((result) => result.update).filter(Boolean);
    const specificationUpdates = existingResults.filter((result) => result.specsChanged).map((result) => result.current);
    summary.specificationsUpdated = specificationUpdates.length;
    const checkedProducts = existingResults.map((result) => result.current).filter(Boolean);

    if (config.discoveryEnabled) {
      const discovery = await discover(config);
      summary.skipped.push(...discovery.errors);
      const existingUrls = new Set(products.map((product) => canonicalUrl(product.url)));
      const existingModels = new Set(products.map((product) => listingKey(product.retailer, product.model)));
      const newCandidates = discovery.candidates.filter((candidate) => !existingUrls.has(canonicalUrl(candidate.url)));
      const discoveredResults = await Promise.all(newCandidates.map((candidate) => limit(async () => {
        try {
          const scraped = await scrape(candidate.url, retailerRequestOptions(candidate.url, config));
          const title = scraped.title || candidate.title || "";
          if (!is85InchTelevisionTitle(title) && !(scraped.televisionVerified && is85InchTitle(scraped.screenSize))) {
            throw new Error(`Rejected candidate without explicit evidence of an 85-inch television: ${title || "untitled page"}`);
          }
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
            checkedAt: new Date().toISOString(),
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
      summary.added.forEach((item, index) => {
        item.row = nextRow + index;
        observations.push(item);
        checkedProducts.push(item);
      });
    }

    summary.best = selectBestModels(checkedProducts, config);
    for (const [category, product] of Object.entries(summary.best)) {
      console.log(`BEST   ${category}: ${product ? `${product.retailer} ${product.model} (${product.price || "price unknown"})` : "no eligible in-stock TV"}`);
    }
    if (!config.dryRun) {
      await writeUpdates(sheets, config, summary.modified);
      await writeSpecifications(sheets, config, specificationUpdates);
      await appendProducts(sheets, config, summary.added, nextRow);
      await highlightBestModels(sheets, config, summary.best);
    }
    console.log(`${config.dryRun ? "Would modify" : "Modified"} ${summary.modified.length} row(s) and ${config.dryRun ? "would add" : "added"} ${summary.added.length} row(s).`);
  } catch (error) {
    runError = error;
    summary.fatalError = error.message;
    console.error(`FATAL  ${error.stack || error.message}`);
  }

  // Record actual observations even if a later discovery or sheet-write step fails.
  summary.historyCount = observations.length;
  try {
    if (!config.dryRun && observations.length) await appendPriceHistory(sheets, config, observations);
    console.log(`HISTORY ${config.dryRun ? "Would record" : "Recorded"} ${observations.length} observations in ${config.historySheetName}`);
  } catch (error) {
    if (!runError) runError = error;
    summary.fatalError = [summary.fatalError, `Price history failed: ${error.message}`].filter(Boolean).join("; ");
    console.error(`HISTORY Failed: ${error.message}`);
  }
  summary.completedAt = new Date().toISOString();
  try {
    await sendEmail(summary, config);
  } catch (error) {
    console.error(`EMAIL  Failed: ${error.message}`);
    if (!runError) runError = new Error(`Update completed but status email failed: ${error.message}`);
  }
  if (runError) throw runError;
  return summary;
}
