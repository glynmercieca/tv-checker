const required = (name, fallback) => {
  const value = process.env[name] || fallback;
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
};

export function getConfig() {
  const smtpUser = process.env.BREVO_SMTP_USER || process.env.SMTP_USER || "";
  const smtpPass = process.env.BREVO_SMTP_KEY || process.env.SMTP_PASS || "";
  return {
    spreadsheetId: required(
      "SPREADSHEET_ID",
      "17AeERTQ8IuFSnUPOKv-w9WdNhxInj2glO4QQtDjZTAw",
    ),
    sheetName: process.env.SHEET_NAME || "Sheet2",
    dryRun: /^true$/i.test(process.env.DRY_RUN || "false"),
    concurrency: Math.max(1, Number(process.env.SCRAPE_CONCURRENCY || 3)),
    requestTimeoutMs: Math.max(5_000, Number(process.env.REQUEST_TIMEOUT_MS || 25_000)),
    userAgent:
      process.env.SCRAPER_USER_AGENT ||
      "Mozilla/5.0 (compatible; TVPriceMonitor/1.0; +https://github.com/)",
    discoveryEnabled: !/^false$/i.test(process.env.DISCOVERY_ENABLED || "true"),
    maxNewProducts: Math.max(1, Number(process.env.MAX_NEW_PRODUCTS || 25)),
    minimumRefreshRateHz: Math.max(1, Number(process.env.MINIMUM_REFRESH_RATE_HZ || 120)),
    email: {
      to: process.env.EMAIL_TO || "",
      from: process.env.EMAIL_FROM || smtpUser,
      smtpHost: process.env.SMTP_HOST || "smtp-relay.brevo.com",
      smtpPort: Number(process.env.SMTP_PORT || 465),
      smtpSecure: !/^false$/i.test(process.env.SMTP_SECURE || "true"),
      smtpUser,
      smtpPass,
    },
  };
}
