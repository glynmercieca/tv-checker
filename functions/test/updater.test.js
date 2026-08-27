import test from "node:test";
import assert from "node:assert/strict";
import { meetsMinimumRefreshRate } from "../src/updater.js";

test("accepts only TVs with a verified maximum refresh rate of at least 120 Hz", () => {
  assert.equal(meetsMinimumRefreshRate("120 Hz"), true);
  assert.equal(meetsMinimumRefreshRate("60 Hz (120 Hz Game Accelerator)"), true);
  assert.equal(meetsMinimumRefreshRate("100 Hz native (144 Hz VRR)"), true);
  assert.equal(meetsMinimumRefreshRate("60 Hz"), false);
  assert.equal(meetsMinimumRefreshRate("Not listed"), false);
  assert.equal(meetsMinimumRefreshRate(""), false);
});

test("supports a configurable minimum refresh rate", () => {
  assert.equal(meetsMinimumRefreshRate("120 Hz", 144), false);
  assert.equal(meetsMinimumRefreshRate("144 Hz", 144), true);
});
