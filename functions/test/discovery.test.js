import test from "node:test";
import assert from "node:assert/strict";
import { canonicalUrl, identityFromTitle, is85InchTelevisionTitle, is85InchTitle, listingKey } from "../src/discovery.js";

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
