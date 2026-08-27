import test from "node:test";
import assert from "node:assert/strict";
import { formatEuro, testing } from "../src/scraper.js";

test("formats euro amounts", () => {
  assert.equal(formatEuro("1398.99"), "€1,398.99");
  assert.equal(formatEuro(undefined), null);
  assert.equal(formatEuro("0"), null);
});

test("parses JSON-LD offer", () => {
  const html = `<script type="application/ld+json">{
    "@type":"Product","offers":{"@type":"Offer","price":"789.00",
    "priceCurrency":"EUR","availability":"https://schema.org/InStock"}
  }</script>`;
  assert.deepEqual(testing.parseDocument(html), {
    price: "€789.00",
    stock: "In stock",
    title: null,
    source: "JSON-LD",
  });
});

test("recognizes explicit quantity", () => {
  assert.equal(testing.stockFromText("Quantity 3 available"), "In stock (3 available)");
  assert.equal(testing.stockFromText("Pre-Order Samsung TV"), "Pre-order");
});

test("parses focused retailer markup without mistaking related products", () => {
  const html = `<main>
    <div id="x_PanelPrice"><span>€789.00</span></div>
    <span class="availability">3 available</span>
    <aside>Related product €99.00 Out of stock</aside>
  </main>`;
  assert.deepEqual(testing.parseDocument(html), {
    price: "€789.00",
    stock: "In stock (3 available)",
    title: null,
    source: "page markup",
  });
});

test("does not invent a price for removed listings", () => {
  assert.deepEqual(testing.parseDocument("<main>Product Not Found</main>"), {
    price: "",
    stock: "Listing unavailable",
    title: null,
    source: "page status",
  });
});
