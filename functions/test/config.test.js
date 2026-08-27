import test from "node:test";
import assert from "node:assert/strict";
import { getConfig } from "../src/config.js";

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
