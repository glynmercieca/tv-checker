import test from "node:test";
import assert from "node:assert/strict";
import { testing } from "../src/email.js";

test("email report contains modifications and additions", () => {
  const message = testing.buildMessage({
    checked: 1,
    modified: [{ retailer: "Shop", model: "TV85", beforePrice: "€10.00", price: "€9.00", beforeStock: "Out", stock: "In" }],
    added: [{ retailer: "Shop", brand: "Brand", model: "NEW85", price: "€99.00", stock: "In stock", url: "https://example.com/new" }],
    skipped: [],
    dryRun: false,
    fatalError: null,
    completedAt: "2026-08-27T00:00:00.000Z",
  });
  assert.match(message.text, /€10\.00 → €9\.00/);
  assert.match(message.text, /NEW85/);
  assert.match(message.html, /https:\/\/example\.com\/new/);
});
