# TV price and stock updater

Reads the product links in `Sheet2!E2:E`, checks each retailer, and updates `F:G` (Price and Stock). It also searches each represented retailer for newly listed 85-inch TVs, appends new listings in `A:G`, and emails a status report after every run. It is preconfigured for the supplied **85\" TVs** spreadsheet.

The scraper prefers structured product data (JSON-LD), then standard product metadata and focused stock text. For WooCommerce shops it also tries the public Store API. If parsing is uncertain or a retailer presents an anti-bot page, that row is skipped: the existing sheet values are not overwritten.

Discovery currently covers all retailers represented in the sheet:

- Forestals and Sound Machine: their WooCommerce television catalog APIs.
- The Atrium and Klikk: their published product sitemaps.
- Scan Malta: its Magento product catalog API.

A candidate is appended only when its product title explicitly says **85 inch**, **85\"**, or **85″**. Model numbers merely containing `85` are not enough. Existing URLs are canonicalized before comparison, and unavailable candidates are rejected. Newly added rows contain retailer, brand, model/title, year when present in the title, URL, price, and stock; technical specification columns `H:V` stay blank for later enrichment.

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
   - Add repository variable `SPREADSHEET_ID` = `17AeERTQ8IuFSnUPOKv-w9WdNhxInj2glO4QQtDjZTAw`.
   - Add repository variable `SHEET_NAME` = `Sheet2`.
   - Add repository variable `EMAIL_FROM` = `TV Monitor <your-verified-sender@example.com>`.
6. Open **Actions → Update TV prices and stock → Run workflow**, keep dry-run enabled, and review the log.
7. Run again with dry-run disabled. Scheduled runs write changes automatically.

Never commit the service-account JSON file.

## Firebase alternative

Firebase is supported by the included second-generation scheduled function. It is useful if this already belongs in a Firebase/Google Cloud project, but scheduled functions require Cloud Scheduler and a billing-capable project.

```bash
npm install -g firebase-tools
cp .firebaserc.example .firebaserc
# Edit .firebaserc with your project ID.
cd functions && npm install && cd ..
firebase deploy --only functions:updateTvPrices
```

Enable the Sheets API in that Google Cloud project, then share the spreadsheet with the runtime service account shown for the deployed function in Google Cloud IAM. Firebase uses Application Default Credentials; do not add a JSON key to the function.

Set the Brevo credentials and email addresses before deploying:

```bash
firebase functions:secrets:set BREVO_SMTP_USER
firebase functions:secrets:set BREVO_SMTP_KEY
firebase functions:secrets:set EMAIL_TO
firebase functions:secrets:set EMAIL_FROM
firebase deploy --only functions:updateTvPrices
```

The scheduled function runs once daily at 07:17 `Europe/Malta`. It connects to `smtp-relay.brevo.com:465` using TLS.

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
- New listings are written to A:G; H:V remain empty.
- Every completed run sends an HTML and plain-text report listing modifications, additions, and skipped checks. A failed email causes the job to fail visibly.
- Brevo is the default transport. Generic `SMTP_USER`, `SMTP_PASS`, `SMTP_HOST`, `SMTP_PORT`, and `SMTP_SECURE` variables remain supported for migration to another TLS SMTP provider.
- `DISCOVERY_ENABLED=false` disables catalog discovery without disabling price checks.
- `MAX_NEW_PRODUCTS` defaults to 25 and stops the run before writing if discovery unexpectedly finds more new candidates.
- HTTP 404/410 or an explicit “Product Not Found” page clears price and sets stock to `Listing unavailable`.
- A retailer block, timeout, or ambiguous page leaves the row unchanged and logs `SKIP`.
- Retailer HTML changes over time. Check scheduled-run logs; repeated `SKIP` entries mean that retailer needs a small parser adjustment.
- Keep concurrency low to avoid burdening retailer sites. The default is three parallel requests.

Run all scraper, discovery, and email-report tests with `cd functions && npm test`.
