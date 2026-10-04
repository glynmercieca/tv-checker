import test from "node:test";
import assert from "node:assert/strict";
import { getConfig } from "../src/config.js";

test("SHEET_NAME_2 selects the history tab and takes priority over the legacy variable", () => {
  const keys = ["SHEET_NAME_2", "HISTORY_SHEET_NAME"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    assert.equal(getConfig().historySheetName, "history");
    process.env.HISTORY_SHEET_NAME = "Legacy history";
    assert.equal(getConfig().historySheetName, "Legacy history");
    process.env.SHEET_NAME_2 = "history";
    assert.equal(getConfig().historySheetName, "history");
    process.env.SHEET_NAME_2 = "Price log";
    assert.equal(getConfig().historySheetName, "Price log");
  } finally {
    for (const key of keys) {
      if (previous[key] == null) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

test("defaults to the renamed tvs tab and preserves explicit tab overrides", () => {
  const previous = process.env.SHEET_NAME;
  try {
    delete process.env.SHEET_NAME;
    assert.equal(getConfig().sheetName, "tvs");
    process.env.SHEET_NAME = "Custom TVs";
    assert.equal(getConfig().sheetName, "Custom TVs");
  } finally {
    if (previous == null) delete process.env.SHEET_NAME;
    else process.env.SHEET_NAME = previous;
  }
});

test("GPT defaults, explicit disabling, and missing-key validation", () => {
  const keys = ["OPENAI_API_KEY", "OPENAI_MODEL", "GPT_CHECKS_ENABLED", "GPT_TIMEOUT_MS"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    assert.equal(getConfig().gptEnabled, false);
    assert.equal(getConfig().openaiModel, "gpt-6.1-sol");
    process.env.OPENAI_API_KEY = "test-key";
    assert.equal(getConfig().gptEnabled, true);
    assert.equal(getConfig().gptTimeoutMs, 60000);
    process.env.GPT_CHECKS_ENABLED = "false";
    assert.equal(getConfig().gptEnabled, false);
    process.env.GPT_CHECKS_ENABLED = "true";
    delete process.env.OPENAI_API_KEY;
    assert.throws(() => getConfig(), /requires OPENAI_API_KEY/);
  } finally {
    for (const key of keys) {
      if (previous[key] == null) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

test("uses Brevo TLS SMTP defaults and credentials", () => {
  const keys = ["BREVO_SMTP_USER", "BREVO_SMTP_KEY", "SMTP_HOST", "SMTP_PORT", "SMTP_SECURE", "MINIMUM_REFRESH_RATE_HZ"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.BREVO_SMTP_USER = "brevo-login";
    process.env.BREVO_SMTP_KEY = "brevo-key";
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_PORT;
    delete process.env.SMTP_SECURE;
    delete process.env.MINIMUM_REFRESH_RATE_HZ;
    const config = getConfig();
    assert.equal(config.email.smtpHost, "smtp-relay.brevo.com");
    assert.equal(config.email.smtpPort, 465);
    assert.equal(config.email.smtpSecure, true);
    assert.equal(config.email.smtpUser, "brevo-login");
    assert.equal(config.email.smtpPass, "brevo-key");
    assert.equal(config.minimumRefreshRateHz, 120);
  } finally {
    for (const key of keys) {
      if (previous[key] == null) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});
