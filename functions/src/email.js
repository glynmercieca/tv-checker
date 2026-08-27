import tls from "node:tls";
import { once } from "node:events";

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function table(headers, rows) {
  if (!rows.length) return "<p>None.</p>";
  const head = headers.map((header) => `<th style="text-align:left;padding:6px;border-bottom:1px solid #ccc">${escapeHtml(header)}</th>`).join("");
  const body = rows.map((row) => `<tr>${row.map((cell) => `<td style="padding:6px;border-bottom:1px solid #eee;vertical-align:top">${escapeHtml(cell)}</td>`).join("")}</tr>`).join("");
  return `<table style="border-collapse:collapse;width:100%"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function buildMessage(summary) {
  const action = summary.dryRun ? "would be" : "were";
  const modifiedRows = summary.modified.map((item) => [
    `${item.retailer} ${item.model}`,
    `${item.beforePrice || "—"} → ${item.price || "—"}`,
    `${item.beforeStock || "—"} → ${item.stock || "—"}`,
  ]);
  const addedRows = summary.added.map((item) => [
    item.retailer,
    `${item.brand} ${item.model}`.trim(),
    item.price || "—",
    item.stock || "—",
    item.url,
  ]);
  const skippedRows = summary.skipped.map((item) => [
    item.retailer || "Run",
    item.model || "—",
    item.error,
  ]);
  const fatal = summary.fatalError ? `<p style="color:#b00020"><strong>Fatal error:</strong> ${escapeHtml(summary.fatalError)}</p>` : "";
  const html = `
    <h2>TV price and stock update${summary.dryRun ? " — dry run" : ""}</h2>
    <p>Checked ${summary.checked} existing listings. ${summary.modified.length} ${action} modified and ${summary.added.length} ${action} added. ${summary.skipped.length} checks were skipped or failed.</p>
    ${fatal}
    <h3>Modified</h3>${table(["Listing", "Price", "Stock"], modifiedRows)}
    <h3>Added</h3>${table(["Retailer", "Model", "Price", "Stock", "URL"], addedRows)}
    <h3>Skipped / failed</h3>${table(["Retailer", "Model", "Reason"], skippedRows)}
    <p>Completed at ${escapeHtml(summary.completedAt)}.</p>`;
  const text = [
    `TV update${summary.dryRun ? " (dry run)" : ""}`,
    `Checked: ${summary.checked}; modified: ${summary.modified.length}; added: ${summary.added.length}; skipped: ${summary.skipped.length}`,
    summary.fatalError ? `Fatal error: ${summary.fatalError}` : "",
    "Modified:",
    ...modifiedRows.map((row) => row.join(" | ")),
    "Added:",
    ...addedRows.map((row) => row.join(" | ")),
    "Skipped / failed:",
    ...skippedRows.map((row) => row.join(" | ")),
  ].filter(Boolean).join("\n");
  return { html, text };
}

export async function sendStatusEmail(summary, config) {
  const email = config.email;
  const configured = email.to && email.from && email.smtpUser && email.smtpPass;
  if (!configured) {
    console.warn("EMAIL Email not sent: configure EMAIL_TO, EMAIL_FROM, BREVO_SMTP_USER and BREVO_SMTP_KEY");
    return { sent: false, reason: "not configured" };
  }
  if (!email.smtpSecure) throw new Error("Only TLS SMTP is supported; use SMTP_SECURE=true and usually port 465");
  const message = buildMessage(summary);
  const subject = `[TV monitor${summary.dryRun ? " dry run" : ""}] ${summary.modified.length} modified, ${summary.added.length} added${summary.fatalError ? " — FAILED" : ""}`;
  await sendSmtp({ ...email, subject, ...message });
  console.log(`EMAIL  Status sent to ${email.to}`);
  return { sent: true };
}

function cleanHeader(value) {
  return String(value || "").replace(/[\r\n]+/g, " ").trim();
}

function envelopeAddress(value) {
  return cleanHeader(value).match(/<([^>]+)>/)?.[1] || cleanHeader(value);
}

function readResponse(socket) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (chunk) => {
      buffer += chunk.toString("utf8");
      const segments = buffer.split("\r\n");
      const lines = (buffer.endsWith("\r\n") ? segments.slice(0, -1) : segments.slice(0, -1)).filter(Boolean);
      const last = lines.at(-1) || "";
      if (/^\d{3} /.test(last)) {
        cleanup();
        resolve({ code: Number(last.slice(0, 3)), text: lines.join("\n") });
      }
    };
    const onError = (error) => { cleanup(); reject(error); };
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
    };
    socket.on("data", onData);
    socket.on("error", onError);
  });
}

function encodedHeader(value) {
  return `=?UTF-8?B?${Buffer.from(cleanHeader(value), "utf8").toString("base64")}?=`;
}

async function command(socket, value, allowedCodes) {
  const pending = readResponse(socket);
  socket.write(`${value}\r\n`);
  const response = await pending;
  if (!allowedCodes.includes(response.code)) throw new Error(`SMTP ${response.code}: ${response.text}`);
  return response;
}

async function sendSmtp({ smtpHost, smtpPort, smtpUser, smtpPass, from, to, subject, text, html }) {
  const socket = tls.connect({
    host: smtpHost,
    port: smtpPort,
    servername: smtpHost,
    rejectUnauthorized: true,
  });
  const pendingGreeting = readResponse(socket);
  await once(socket, "secureConnect");
  const greeting = await pendingGreeting;
  if (greeting.code !== 220) throw new Error(`SMTP ${greeting.code}: ${greeting.text}`);
  await command(socket, "EHLO tv-price-monitor", [250]);
  await command(socket, "AUTH LOGIN", [334]);
  await command(socket, Buffer.from(smtpUser).toString("base64"), [334]);
  await command(socket, Buffer.from(smtpPass).toString("base64"), [235]);
  await command(socket, `MAIL FROM:<${envelopeAddress(from)}>`, [250]);
  for (const recipient of String(to).split(",").map((item) => item.trim()).filter(Boolean)) {
    await command(socket, `RCPT TO:<${envelopeAddress(recipient)}>`, [250, 251]);
  }
  await command(socket, "DATA", [354]);

  const boundary = `tv-monitor-${Date.now().toString(36)}`;
  const headers = [
    `From: ${cleanHeader(from)}`,
    `To: ${cleanHeader(to)}`,
    `Subject: ${encodedHeader(subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  const body = [
    ...headers,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    text,
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    html,
    `--${boundary}--`,
    "",
  ].join("\r\n").replace(/^\./gm, "..");
  const accepted = readResponse(socket);
  socket.write(`${body}\r\n.\r\n`);
  const dataResponse = await accepted;
  if (dataResponse.code !== 250) throw new Error(`SMTP ${dataResponse.code}: ${dataResponse.text}`);
  await command(socket, "QUIT", [221]);
  socket.end();
}

export const testing = { buildMessage, cleanHeader, envelopeAddress, escapeHtml };
