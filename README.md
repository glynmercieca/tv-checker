# TV price and stock updater

Reads the product links in `tvs!E2:E`, checks each retailer, and updates `F:G` (Price and Stock) plus verified technical specifications in `H:L`. It searches Maltese retailers for new 85-inch gaming TVs, appends new listings in `A:L`, highlights the best available models in column C, records every check in a separate price-history tab, and emails a status report. It is preconfigured for the supplied **85\" TVs** spreadsheet; the product tab defaults to **tvs**.

The scraper prefers structured product data (JSON-LD), then standard product metadata and focused stock text. For WooCommerce shops it also tries the public Store API. If parsing is uncertain or a retailer presents an anti-bot page, that row is skipped: the existing sheet values are not overwritten.

## GPT product checks

Set `OPENAI_API_KEY` to enable GPT checks automatically. The default model is `gpt-6.1-sol`, selected for its balance of intelligence and cost and support for structured output ([official model documentation](https://developers.openai.com/api/docs/models/gpt-6.1-sol)). No additional npm dependency is required.

GPT reviews fetched product pages, including pages that the markup parser cannot read. It extracts the primary TV's title, current euro price, availability, and technical specifications. Every extracted field must have an exact supporting quote in the supplied page; absent or uncertain facts remain unknown. Related products, instalments, old prices, motion marketing rates, and instructions embedded in retailer pages are excluded by the extraction prompt. Quote checks verify that evidence exists; they cannot guarantee the model interprets it correctly.

When GPT is enabled, only its supported, normalized fields are used. An unknown price or stock preserves that field's existing sheet value. A price/stock disagreement with the parser, API error, refusal, malformed response, or unsupported evidence skips the row. The existing 85-inch title and minimum refresh-rate checks still apply to new listings. HTTP 404/410 and explicit unavailable pages retain their existing handling. GPT cannot read blocked or failed HTTP pages; the public Woo Store API remains the fallback for those pages.

Requests send up to 30,000 characters of retailer page text/metadata to OpenAI, with response storage disabled. Each readable product page requires one paid API request, including during dry runs. Existing scraper concurrency limits also apply to GPT requests.

- `OPENAI_API_KEY`: add as a GitHub Actions repository **secret**, or set locally. Never commit the key.
- `OPENAI_MODEL`: optional repository variable/environment variable; defaults to `gpt-6.1-sol`. Overrides must support the Responses API, structured output, and low reasoning effort.
- `GPT_CHECKS_ENABLED=false`: disables GPT even with a key. With no key, the existing scraper runs unchanged; explicitly setting `true` without a key fails configuration.
- `GPT_TIMEOUT_MS`: local request timeout, defaults to 60,000 milliseconds.

After adding the secret, run the workflow with dry-run enabled and review `GPT` sources and `SKIP` reasons before enabling writes.

## Retailer discovery

Discovery covers nine Maltese retailers:

- Forestals and Sound Machine: their WooCommerce television catalog APIs.
- The Atrium and Klikk: their published product sitemaps.
- Scan Malta: its Magento product catalog API.
- Audio Malta and Digital Zone: their public Woo Store product search APIs.
- Ultimate and Telecom: their 85-inch TV category pages, including linked next pages.

Woo catalogs search across all product categories to catch differently named TV categories; sitemap indexes are followed recursively. Each retailer has a 20-page discovery limit, and excessive pagination is reported rather than silently dropping results. Accessories and duplicates are filtered before additions. Some retailer requests are blocked: these appear in the report as discovery failures and do not remove existing listings. Public catalog discovery was checked for Ultimate, Audio Malta, and Digital Zone; Telecom returned HTTP 403 during verification.

A candidate is appended only when its product title explicitly identifies an **85-inch TV**, or GPT verifies a television and quotes its **85-inch diagonal size** elsewhere on the product page, and the product page verifies support for at least **120 Hz**. Model numbers merely containing `85` are not enough. Existing URLs are canonicalized before comparison, and unavailable candidates or candidates without a verifiable refresh rate are rejected. Newly added rows contain retailer, brand, model/title, year when present in the title, URL, price, stock, panel technology, maximum supported refresh rate, operating system, VRR support, and HDMI 2.1 support. Specifications are extracted from structured data, labelled product tables, and focused product-page text; a retailer omission is recorded as `Not listed` rather than guessed.

## Best-model highlights

After each successful run, model cells in column C receive managed conditional-formatting rules:

- **`#51acb7`**: best in-stock gaming model at any price.
- **`#d09be6`**: best in-stock gaming model with a newly verified price strictly below **€1,200**.
- When the same listing wins both, the cell has a teal background and bold purple text.

Eligibility requires newly confirmed `In stock` or `Low stock`, a known panel technology, and a verified maximum supported refresh rate of at least 120 Hz. Failed checks, unknown stock, out-of-stock listings, and pre-orders are excluded. A missing price can qualify for best overall, but cannot qualify for the budget selection. No qualifying TV means no highlight for that category; old checker highlights are removed each successful run. Unrelated user formatting rules and base fills are preserved.

The transparent specification-based ordering is OLED, RGB Mini LED, other Mini LED/Neo QLED, QLED/QNED, then conventional LED/LCD. Within a panel tier, higher supported refresh rate comes first, followed by verified VRR, HDMI 2.1, and Google TV. Google TV is a bonus, never a requirement. Lower price breaks remaining ties, followed by sheet order. This is a shopping heuristic based on listed specifications, not an independent picture-quality or input-lag assessment. Previously verified sheet specifications are retained when a retailer omits them in a later check; newly extracted specifications refresh H:L.

## Price history for November deals

The first non-dry run with observations creates **Price history** (or `HISTORY_SHEET_NAME`) in the same spreadsheet. Every run appends a timestamped row for each existing listing, even when its price has not changed, plus each accepted new listing. Columns are: checked-at UTC timestamp, retailer, brand, model, product link, numeric euro price, stock, and check status. Prices use currency formatting and can be filtered/charted by product link or retailer/model.

Failed checks and unknown prices leave price blank; they never carry a previous price forward as a fresh observation. A later discovery/write failure does not discard completed checks. The history is append-only, continues through November 2026 and beyond, and is never erased by later runs. Logging starts with the next non-dry run; earlier price history cannot be reconstructed. Dry runs compute recommendations and observation counts but do not create tabs, change formatting, or write history.

If an existing history tab has different headers, the checker reports an error rather than overwriting it. Choose a separate tab via `HISTORY_SHEET_NAME` if needed.

## Email service: Brevo Free

The project is configured for Brevo's encrypted SMTP relay. Brevo Free currently allows 300 sends per day, so a single daily status message is comfortably inside the free tier.

1. Create a free Brevo account.
2. In Brevo, add and verify the sender address that reports should come from.
3. Open **Transactional → Settings → SMTP & API → SMTP** and generate an SMTP key.
4. Keep the displayed SMTP login and generated SMTP key; these become `BREVO_SMTP_USER` and `BREVO_SMTP_KEY` below. Use the SMTP key, not a Brevo API key.

Brevo SMTP reference: https://developers.brevo.com/docs/smtp-integration

## Recommended hosting: GitHub Actions

GitHub Actions is the simplest option for this workload. The included workflow runs once daily at 07:17 in the `Europe/Malta` timezone and can also be run manually in dry-run mode.

1. Create a Google Cloud project and enable the Google Sheets API.
2. Create a service account and a JSON key.
3. Share the spreadsheet with the service account's `client_email` as **Editor**.
4. Push this folder to a GitHub repository.
5. In **Settings → Secrets and variables → Actions**:
   - Add repository secret `GOOGLE_SERVICE_ACCOUNT_JSON` containing the full, single-line service-account JSON.
   - Add repository secret `EMAIL_TO` containing the address that should receive reports.
   - Add repository secret `BREVO_SMTP_USER` containing the SMTP login displayed by Brevo.
   - Add repository secret `BREVO_SMTP_KEY` containing the generated Brevo SMTP key.
   - Add repository secret `OPENAI_API_KEY` to enable GPT checks.
   - Add repository variable `SPREADSHEET_ID` = `17AeERTQ8IuFSnUPOKv-w9WdNhxInj2glO4QQtDjZTAw`.
   - Add repository variable `SHEET_NAME` = `tvs` (the renamed product tab).
   - Add repository variable `EMAIL_FROM` = `TV Monitor <your-verified-sender@example.com>`.
6. Open **Actions → Update TV prices and stock → Run workflow**, keep dry-run enabled, and review the log.
7. Run again with dry-run disabled. Scheduled runs write changes automatically.

Never commit the service-account JSON file.

If Actions reports `Unable to parse range: 'Sheet2'!A2:V`, check **Settings → Secrets and variables → Actions → Variables → SHEET_NAME**. This must be the tab name shown at the bottom of Google Sheets, not the spreadsheet file name. The checker now reads only A:L and resolves the configured name against actual tabs before any product writes. Case/whitespace differences are corrected; a missing or renamed tab is auto-selected only if exactly one non-history tab has the expected retailer/brand/model/link/price/stock columns. Otherwise, the log lists available tabs so you can set the exact name. The resolved title is used for all updates, new listings, specifications, and highlights.

## Local dry run

```bash
cd functions
npm install
export GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/service-account.json
export DRY_RUN=true
export EMAIL_TO=you@example.com
export EMAIL_FROM='TV Monitor <your-verified-sender@example.com>'
export BREVO_SMTP_USER=your-brevo-smtp-login
export BREVO_SMTP_KEY=your-brevo-smtp-key
npm start
```

## Behaviour and maintenance

- Source columns: URL in E, current price in F, current stock in G.
- Writes are batched and limited to changed F:G rows.
- New listings are written to A:L, including the five technical fields in H:L.
- Every completed run sends an HTML and plain-text report listing modifications, additions, and skipped checks. A failed email causes the job to fail visibly.
- Brevo is the default transport. Generic `SMTP_USER`, `SMTP_PASS`, `SMTP_HOST`, `SMTP_PORT`, and `SMTP_SECURE` variables remain supported for migration to another TLS SMTP provider.
- `DISCOVERY_ENABLED=false` disables catalog discovery without disabling price checks.
- `MAX_NEW_PRODUCTS` defaults to 25 and stops the run before writing if discovery unexpectedly finds more new candidates.
- `MINIMUM_REFRESH_RATE_HZ` defaults to 120 and can raise the gaming minimum. Values below 120 are clamped to 120. Newly discovered TVs below that maximum supported rate, or whose refresh rate cannot be verified, are skipped.
- HTTP 404/410 or an explicit “Product Not Found” page clears price and sets stock to `Listing unavailable`.
- A retailer block, timeout, or ambiguous page leaves the row unchanged and logs `SKIP`.
- Retailer HTML changes over time. Check scheduled-run logs; repeated `SKIP` entries mean that retailer needs a small parser adjustment.
- Keep concurrency low to avoid burdening retailer sites. The default is three parallel requests.

Run all scraper, discovery, and email-report tests with `cd functions && npm test`.
