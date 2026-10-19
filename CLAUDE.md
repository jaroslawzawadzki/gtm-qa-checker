# GTM QA Checker – project context for Claude Code

Read this first. It replaces the chat history that stayed on the old laptop.

## Who / how we work
- Owner: Jarosław Zawadzki (GitHub `jaroslawzawadzki`), tracking/analytics agency **smarketer.group**.
  Writes in **Polish** (often quickly, with typos) – answer in Polish. The extension UI defaults to English (EN/DE/PL switch).
- Team: agency specialists, many on shared Google accounts (e.g. reports@). Distribution = **ZIP + "Load unpacked"**
  (see `INSTALL.txt`), GitHub Releases in the private repo. Not in the Chrome Web Store.
- Ask before `git commit` / `push` / releases unless the user asked for it ("wrzuć do gita" = commit + push + release).
  Bump `version` in `public/manifest.json` **and** `package.json`, `npm run package`, then
  `gh release create v<ver> release/gtm-qa-checker-<ver>.zip`.
- Never commit client data: no container dumps, captures, reports, API keys. Scan staged diffs for `GTM-XXXX`,
  `accounts/<digits>`, `AIza…`, `sk-…` before committing.
- GTM access is **read-only**: only GET requests, never save/publish in client containers. The user's account has
  full access to many client containers – be careful.
- Never read or print the user's LLM API key (only check presence).

## What the extension does (Chrome MV3, TypeScript + Vite, `npm run build` / `npm run dev` / `npm run package`)
On **tagmanager.google.com** (`src/content/`):
- Panel (Shadow DOM, launcher pill "QA" bottom right; smarketer branding: #340254, gradient #3C0A6D→#6E6EAA, Inter font in `public/fonts`).
  Tabs: Data, Diff, QA, Report, Settings, Debug.
- Data capture: `src/injected/injected.ts` (MAIN world, document_start) intercepts fetch/XHR of GTM's internal API and
  does active GETs from the user's session; everything is parsed only in `src/adapters/gtmApiAdapter.ts`.
- Diff engine (`src/diff/`): workspace vs version, version range, last N hours.
- QA linter (`src/qa/`): resolver `{{var}}` → real source (dataLayer path, constant, JS, cookie, URL…); source consistency
  per event field (value, currency, transaction_id, items, event_id), duplicates, data types, conversions, GA4 PII,
  consent (**info only** – consent is the client's decision), SST (`sst.ts`: server_container_url, GA4 Bridge / Data Tag (Stape) / other),
  naming taxonomy (`taxonomy.ts`, Task 12: `[SST] Platform - Event`, triggers `ce - / pv - / window_loaded -`,
  variables `DLV - / CJS - / COOKIE - / CONST - / URL -`) with "How to fix" suggestions (`Finding.fixes`).
  FAST (internal fingerprint tool) needs no consent; FAST Script may live in page code – not an error.
- Markers in GTM lists (`overlay.ts`): red/yellow/blue dots on tag/trigger/variable rows + left menu; hollow ring on tags that
  use elements with findings; naming findings always blue. Click opens QA filtered to the element.
- Report (`src/report/`): one-click "Create report from my changes" (workspace diff, else last publication), compact by default,
  purchase-tag comparison table, optional AI summary. Reminder bubble on Submit/Publish.
- Agency exceptions (`src/shared/exceptions.ts`): "Not an error" + reason, AI rules, **feedback records**; JSON export,
  import only appends. Planned: shared team database (record format is ready).
- Google tag settings best practices (`settingsGuide.ts`, content in `src/guide/googleTagGuide.ts` from the user's Word doc
  `docs/Google Tag Best Practices - Dokument Konfiguracyjny.docx`): badges on Container → Settings rows, card when a setting opens
  (route `/activities/<id>`), overview + "Combine Google tags?".
- LLM calls only in the service worker (`src/background/serviceWorker.ts`, `src/llm/`): Anthropic SDK (default `claude-opus-5-5`),
  OpenAI and Gemini via REST with retry. Sanitized payload (no Custom HTML/JS, no e-mails/secrets). Prompts in English, answer in UI language;
  agency AI rules appended.

On **tagassistant.google.com** (GTM Preview, `src/preview/preview.ts`):
- Ongoing audit: while the user is idle (~1.8 s without input in TA) new events are briefly selected, Tags / Variables / Data Layer
  read, then the user's view is restored. Live checks: failed tag, fired N× in one event, blocked by consent (info), conversion event
  without tags. Dots / ✓ between event number and name (right edge is used by TA hover controls).
- Container QA findings come from the GTM tab via `chrome.storage` (`src/shared/previewQa.ts`, saved on every Run QA, keyed `previewQa:GTM-XXXX`).
- AI review in batches for events with fired tags (`llm:preview`, JSON answer), cached per container by event fingerprint
  (`previewAi:GTM-XXXX`, 150 entries), audit state in sessionStorage (survives F5), max 15 automatic requests per session, toggle in Settings.
- Feedback 👍 / 👎 with "why" on every finding → feedback record, optional AI rule; 👎 hides the finding for that tag/container permanently.

## GTM / Tag Assistant internals we learned (keep – they are not documented)
- GTM UI API `/api/accounts/{a}/containers/{c}/...`, XSSI prefix `)]}'`, `{"default":…}` envelope; entities `{key:{tagId|triggerId|macroId,…}, data:{…}}`;
  type in `data.vendorTemplate.key.publicId`; value enums 1 string, 2 list, 3 map, 4 macro, 6 int, 8 bool; list endpoints omit params,
  detail endpoints have them. Custom templates `cvt_<galleryId>` / `cvt_<containerId>_<templateId>`.
- GTM DOM: AngularJS without debug info (no scope access). Rows `tr[gtm-table-row]` (triggers/variables, matched by name),
  tags list `tr.wd-tag-row` + `a.open-tag-button` (id in href). Left menu `a.gtm-container-menu-list-item`.
  Settings page rows `.activity-slat.activity-slat--<publicId>` (e.g. `ogt_dtc`); singleton activity ids 2147480577… (see `ACTIVITY_ROUTE_IDS`).
- Tag Assistant: events `.message-list__row--indented` (selected `--selected`), tiles `tags-tab .tags-tab__tag`, name `.gtm-debug-card__title`,
  sections `.tags-tab__fired-tags` / `.tags-tab__blocked-tags`, tabs `.header__tab[data-ng-click="ctrl.selectTab(Tab.VARIABLES|DATALAYER|TAGS)"]`,
  variables table in `variables-tab`, dataLayer in `data-data-layer-tab`. Data arrives via MessageChannel – **do not hook MessagePort**
  (it froze the tab). After F5 Tag Assistant (and GTM, same renderer) can be unresponsive for 1–2 min – that is TA itself.
- GTM and Tag Assistant share one renderer process (both google.com).

## Testing setup (on the user's machine)
- Separate Chrome profile started with `--remote-debugging-port=9222` (profile dir `chrome-claude-profile`), logged in with the agency account.
  The extension is loaded unpacked from `dist/`; reload via `chrome.developerPrivate.reload('<extension id>')` from a `chrome://extensions` tab
  (the id changes on a new machine – look it up there).
- Small CDP helper scripts (Node, `WebSocket` to `/json/list` targets): evaluate in a tab, real mouse click (`Input.dispatchMouseEvent`
  for popups like Preview), `Page.captureScreenshot`. Keep them in the session scratchpad, not in the repo.
- The user often works in the same test browser at the same time – avoid navigating their tabs; ask before reloads that could lose work.
- Bash + backticks in `node -e` breaks template literals – use the Edit tool for code with template strings.

## History
- 0.1–0.2 (2026-10-14): MVP – capture, adapter, diff, QA, LLM, report, exceptions, i18n, branding, packaging.
- 0.3.0 (2026-10-15): markers in GTM lists, naming "How to fix", Google tag best practices on Settings, INSTALL.txt, compact report.
- 0.4.0 (2026-10-15): ongoing Preview audit with AI, coloured tiles, feedback 👍/👎, AI cache.

## Open ideas (not started)
- Shared team database for exceptions / feedback / AI rules (one page, AI learns from everyone).
- QA reading the actual Google tag settings values and comparing them with the best-practice document.
- Option "AI reviews all Preview events" (now only events with fired tags).
- Chrome Web Store listing.
