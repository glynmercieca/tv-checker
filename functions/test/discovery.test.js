import test from "node:test";
import assert from "node:assert/strict";
import { canonicalUrl, identityFromTitle, is85InchTelevisionTitle, is85InchTitle, listingKey, testing } from "../src/discovery.js";

test("requires an explicit 85-inch size", () => {
  assert.equal(is85InchTitle("Samsung UE85U8000 85-inch Smart TV"), true);
  assert.equal(is85InchTitle("Samsung UE85M70 75-inch Smart TV"), false);
  assert.equal(is85InchTitle("Samsung 55A85Q 55-inch OLED"), false);
});

test("rejects accessories that merely mention 85-inch TVs", () => {
  assert.equal(is85InchTelevisionTitle("Philips Sync Box Starter Kit for 75-85 inch TVs"), false);
  assert.equal(is85InchTelevisionTitle("Hisense 85A6Q 85-inch UHD Smart TV"), true);
});

test("canonicalizes retailer URLs for duplicate detection", () => {
  assert.equal(
    canonicalUrl("https://www.example.com/product/tv/?utm_source=x#details"),
    "https://example.com/product/tv",
  );
});

test("extracts a known brand and model", () => {
  assert.deepEqual(identityFromTitle("Samsung UE85U8000FUXZT 85″ Crystal UHD Smart TV"), {
    brand: "Samsung",
    model: "UE85U8000FUXZT",
    year: "",
    title: "Samsung UE85U8000FUXZT 85″ Crystal UHD Smart TV",
  });
});

test("recognizes the same retailer model despite a descriptive suffix", () => {
  assert.equal(
    listingKey("Forestals", "K-85S35BP (BRAVIA 3)"),
    listingKey("Forestals", "K-85S35BP"),
  );
  assert.notEqual(
    listingKey("Forestals", "85A6Q"),
    listingKey("Sound Machine", "85A6Q"),
  );
});

test("follows sitemap indexes without treating image or off-site URLs as listings", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    calls.push(String(url));
    return new Response(String(url).endsWith("index.xml")
      ? '<sitemapindex><sitemap><loc>https://example.com/products.xml</loc></sitemap><sitemap><loc>https://other.com/map.xml</loc></sitemap></sitemapindex>'
      : '<urlset><url><loc>https://example.com/product/tcl-85c8k</loc><image:loc>https://example.com/85-image.jpg</image:loc></url><url><loc>https://example.com/product/75-tv</loc></url></urlset>');
  });
  const result = await testing.discoverSitemap({ retailer: "Shop", url: "https://example.com/index.xml", requiredPath: "/product/" }, { requestTimeoutMs: 5000 });
  assert.deepEqual(result, [{ retailer: "Shop", url: "https://example.com/product/tcl-85c8k" }]);
  assert.equal(calls.length, 2);
});

test("category discovery follows next pages and rejects accessories and cart links", async (t) => {
  t.mock.method(globalThis, "fetch", async (url) => new Response(String(url).endsWith("page2")
    ? '<a href="/product/sony-85x90"><h2>Sony 85-inch TV</h2></a>'
    : '<a href="/product/tcl-85c8k"><h2>TCL 85-inch TV</h2></a><a href="/product/mount">Mount for 85-inch TV</a><a href="/product/tv?add-to-cart=1">85-inch TV</a><a rel="next" href="/page2">Next</a>'));
  const result = await testing.discoverCategory({ retailer: "Shop", url: "https://example.com/category", productPath: "/product/" }, { requestTimeoutMs: 5000 });
  assert.equal(result.length, 2);
  assert.ok(result.every((item) => !item.url.includes("mount") && !item.url.includes("cart")));
});

test("Woo discovery searches all categories and paginates with a safety limit", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    calls.push(new URL(url));
    return Response.json(calls.length === 1
      ? Array.from({ length: 100 }, (_, index) => ({ name: index === 0 ? "TCL 85-inch TV" : "85-inch Mount", permalink: `https://example.com/product/${index}` }))
      : [{ name: "Sony 85-inch TV", permalink: "https://example.com/product/sony85" }]);
  });
  const result = await testing.discoverWoo({ retailer: "Shop", baseUrl: "https://example.com" }, { requestTimeoutMs: 5000 });
  assert.equal(result.length, 2);
  assert.equal(calls[0].searchParams.get("search"), "85");
  assert.equal(calls[1].searchParams.get("page"), "2");
});
