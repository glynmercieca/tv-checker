import test from "node:test";
import assert from "node:assert/strict";
import { formatEuro, maxSupportedRefreshRate, testing } from "../src/scraper.js";

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

test("extracts technical specifications for newly discovered TVs", () => {
  const html = `<main>
    <h1>TCL 85-inch QD-MiniLED Google TV</h1>
    <p>144Hz Native Refresh Rate with VRR and HDMI 2.1.</p>
    <div id="x_PanelPrice">€2499.00</div>
    <span class="availability">In stock</span>
  </main>`;
  assert.deepEqual(testing.parseDocument(html).specs, {
    panelTechnology: "QD-Mini LED",
    refreshRate: "144 Hz",
    os: "Google TV",
    vrr: "Yes",
    hdmi21: "Yes",
  });
});

test("uses the highest explicitly supported refresh rate", () => {
  assert.equal(maxSupportedRefreshRate("60 Hz (120 Hz Game Accelerator)"), 120);
  assert.equal(maxSupportedRefreshRate("100 Hz native with up to 144 Hz VRR"), 144);
  assert.equal(maxSupportedRefreshRate("50–60 Hz"), 60);
  assert.equal(maxSupportedRefreshRate("60 Hz native; Motion Rate 240 Hz"), 60);
  assert.equal(maxSupportedRefreshRate("Not listed"), null);

  const html = `<main>
    <h1>Samsung 85-inch TV</h1><meta itemprop="price" content="1999">
    <table><tr><th>Refresh rate</th><td>100 Hz native</td></tr></table>
    <p>Supports up to 144 Hz VRR.</p>
  </main>`;
  assert.equal(testing.parseDocument(html).specs.refreshRate, "144 Hz");
});

test("prefers labelled specification values", () => {
  const html = `<main>
    <h1>Hisense 85-inch TV</h1><meta itemprop="price" content="999">
    <table><tr><th>Display technology</th><td>QLED</td></tr>
    <tr><th>Refresh rate</th><td>120 Hz native</td></tr>
    <tr><th>Operating system</th><td>VIDAA</td></tr>
    <tr><th>VRR</th><td>No</td></tr>
    <tr><th>HDMI 2.1</th><td>Yes</td></tr></table>
  </main>`;
  assert.deepEqual(testing.parseDocument(html).specs, {
    panelTechnology: "QLED",
    refreshRate: "120 Hz",
    os: "VIDAA",
    vrr: "No",
    hdmi21: "Yes",
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
