import test from "node:test";
import assert from "node:assert/strict";
import { checkProductWithGpt, pageEvidence } from "../src/gpt.js";
import { scrapeProduct, testing } from "../src/scraper.js";

const fields = ["title", "screenSize", "price", "stock", "panelTechnology", "refreshRate", "os", "vrr", "hdmi21"];
const html = `<main><h1>Samsung 85-inch TV</h1><p>Price EUR 1.299,00</p><p>In stock</p>
  <p>Refresh rate 120 Hz native; Motion Rate 240 Hz</p><p>VRR: No</p></main>`;
const options = { gptEnabled: true, openaiApiKey: "test-key", openaiModel: "gpt-6.1-sol", requestTimeoutMs: 5000 };
function facts() {
  return {
    isProductPage: true,
    ...Object.fromEntries(fields.map((field) => [field, { value: null, evidence: null }])),
    title: { value: "Samsung 85-inch TV", evidence: "Samsung 85-inch TV" },
    price: { value: "1.299,00", evidence: "Price EUR 1.299,00" },
    stock: { value: "In stock", evidence: "In stock" },
    refreshRate: { value: "120 Hz", evidence: "Refresh rate 120 Hz native; Motion Rate 240 Hz" },
    vrr: { value: "No", evidence: "VRR: No" },
  };
}
function response(data = facts(), extra = {}) {
  return Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(data) }] }], ...extra });
}

test("reviews unfamiliar markup with grounded GPT facts and preserves negations", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    requests.push({ url, init });
    return url.startsWith("https://api.openai.com") ? response() : new Response(html);
  });
  const result = await scrapeProduct("https://example.com/tv", options);
  assert.equal(result.price, "€1,299.00");
  assert.equal(result.stock, "In stock");
  assert.equal(result.specs.refreshRate, "120 Hz");
  assert.equal(result.specs.vrr, "No");
  assert.equal(result.specs.hdmi21, "");
  const body = JSON.parse(requests[1].init.body);
  assert.equal(body.model, "gpt-6.1-sol");
  assert.equal(body.store, false);
  assert.equal(body.text.format.strict, true);
  assert.equal(requests.length, 2);
});

test("rejects invented evidence, currencies, non-TV pages, and missing titles", async (t) => {
  for (const mutate of [
    (data) => { data.price.evidence = "EUR 9.00"; },
    (data) => { data.price.evidence = "1.299,00"; },
    (data) => { data.isProductPage = false; },
    (data) => { data.title = { value: null, evidence: null }; },
    (data) => { data.stock.value = "Out of stock"; },
  ]) {
    const data = facts(); mutate(data);
    const mock = t.mock.method(globalThis, "fetch", async () => response(data));
    await assert.rejects(checkProductWithGpt("https://example.com/tv", html, options));
    mock.mock.restore();
  }
});

test("failed GPT requests skip validation without calling Woo fallback", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    calls++;
    return url.startsWith("https://api.openai.com") ? new Response("unavailable", { status: 429 }) : new Response(html);
  });
  await assert.rejects(scrapeProduct("https://example.com/tv", options), /HTTP 429/);
  assert.equal(calls, 2);
});

test("rejects parser disagreements instead of silently overwriting", async (t) => {
  t.mock.method(globalThis, "fetch", async (url) => url.startsWith("https://api.openai.com")
    ? response() : new Response(`${html}<meta property="product:price:amount" content="999">`));
  await assert.rejects(scrapeProduct("https://example.com/tv", options), /disagree/);
});

test("unknown GPT fields stay null rather than accepting unverified parser values", async (t) => {
  const data = facts(); data.price = { value: null, evidence: null };
  t.mock.method(globalThis, "fetch", async (url) => url.startsWith("https://api.openai.com")
    ? response(data) : new Response(`${html}<meta property="product:price:amount" content="999">`));
  assert.equal((await scrapeProduct("https://example.com/tv", options)).price, null);
});

test("incomplete, refused, and malformed responses are rejected", async (t) => {
  for (const body of [
    { status: "incomplete" },
    { status: "completed", output: [{ type: "message", content: [{ type: "refusal" }] }] },
    { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "not json" }] }] },
  ]) {
    const mock = t.mock.method(globalThis, "fetch", async () => Response.json(body));
    await assert.rejects(checkProductWithGpt("https://example.com/tv", html, options));
    mock.mock.restore();
  }
});

test("disabled GPT and unavailable listings make no OpenAI requests", async (t) => {
  const calls = [];
  let status = 200;
  t.mock.method(globalThis, "fetch", async (url) => {
    calls.push(url);
    return new Response('<main><h1>TV</h1><span class="availability">In stock</span></main>', { status });
  });
  assert.equal((await scrapeProduct("https://example.com/tv", { ...options, gptEnabled: false })).stock, "In stock");
  status = 404;
  assert.equal((await scrapeProduct("https://example.com/tv", options)).stock, "Listing unavailable");
  assert.equal(calls.length, 2);
  assert.ok(calls.every((url) => !url.includes("openai.com")));
});

test("blocked pages use the public API without asking GPT to invent product data", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    calls.push(String(url));
    return String(url).includes("wp-json") ? Response.json([]) : new Response("<body>Verify you are human</body>");
  });
  await assert.rejects(scrapeProduct("https://example.com/tv", options), /did not find/);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((url) => !url.includes("openai.com")));
});

test("bounds evidence and removes unrelated markup", () => {
  const text = pageEvidence(`${html}<aside>Other TV €99.00</aside><script>secret instructions</script><p>${"x".repeat(40000)}</p>`);
  assert.equal(text.length, 30000);
  assert.ok(!text.includes("Other TV"));
  assert.ok(!text.includes("secret instructions"));
});

test("normalizes euro amounts conservatively", () => {
  for (const amount of ["€1,299.00", "EUR 1.299,00", "1299,00", "1,299", "1299"]) {
    assert.equal(testing.gptPrice(amount), "€1,299.00");
  }
  for (const amount of ["from 1299", "1299 or 1499", "0", "USD 1299"]) assert.equal(testing.gptPrice(amount), null);
});
