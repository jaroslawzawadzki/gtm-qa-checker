// Styles live inside the shadow root, so they neither leak into nor inherit from GTM's CSS.
// Palette and typeface follow smarketer.group (primary #340254, primary-light #ae93d6,
// gradient #6E6EAA → #3C0A6D, light blue #46b5fc, dark blue #253269, Inter).
export const styles = /* css */ `
:host { all: initial; }
* { box-sizing: border-box; }

.root {
  --primary: #340254;
  --primary-hover: #4a0d75;
  --primary-light: #ae93d6;
  --primary-soft: #f3eefa;
  --primary-softer: #faf7fd;
  --gradient: linear-gradient(135deg, #3c0a6d 0%, #6e6eaa 100%);
  --accent: #46b5fc;
  --accent-soft: #e6f5ff;
  --navy: #253269;
  --gold: #c29400;

  --bg: #ffffff;
  --bg-soft: #f9fafb;
  --bg-muted: #f3f4f6;
  --border: #e5e7eb;
  --border-strong: #d1d5db;
  --text: #111827;
  --text-2: #374151;
  --muted: #6b7280;

  --ok: #047857;      --ok-soft: #ecfdf5;      --ok-line: #10b981;
  --warn: #b45309;    --warn-soft: #fffbeb;    --warn-line: #f59e0b;
  --crit: #b91c1c;    --crit-soft: #fef2f2;    --crit-line: #ef4444;
  --info: #1d4ed8;    --info-soft: #eff6ff;    --info-line: #46b5fc;

  --radius: 10px;
  --radius-sm: 6px;
  --shadow-sm: 0 1px 2px rgba(17, 24, 39, .06);
  --shadow: 0 4px 14px rgba(52, 2, 84, .10);

  font: 13px/1.5 'GtmQaInter', Inter, 'Segoe UI', system-ui, -apple-system, Arial, sans-serif;
  font-feature-settings: 'cv11', 'ss01';
  color: var(--text);
  -webkit-font-smoothing: antialiased;
}

/* --- launcher & panel shell --------------------------------------------------- */

.launcher {
  position: fixed; right: 22px; bottom: 22px; z-index: 2147483647;
  display: flex; align-items: center; gap: 8px; height: 46px; padding: 0 18px 0 14px;
  border-radius: 999px; border: 1px solid rgba(255, 255, 255, .18); cursor: pointer;
  background: var(--gradient); color: #fff; font: 700 15px/1 'GtmQaInter', Inter, system-ui, sans-serif; letter-spacing: .05em;
  box-shadow: 0 8px 22px rgba(52, 2, 84, .38);
  transition: transform .15s ease, box-shadow .15s ease;
}
.launcher .brand-mark { width: 17px; height: 22px; display: block; }
.launcher .brand-mark svg { width: 100%; height: 100%; display: block; }
.launcher-dot {
  position: absolute; top: -3px; right: -3px; width: 14px; height: 14px; border-radius: 50%;
  background: #ef4444; border: 2px solid #fff;
}
.launcher-dot[hidden] { display: none; }

/* one-click report card */
main section.quick-report { background: var(--primary-softer); border-color: var(--primary-soft); }
main section.quick-report .btn.primary { margin-top: 4px; padding: 9px 18px; }

.link-btn {
  border: none; background: none; padding: 0; cursor: pointer; font: inherit; font-size: 12px; font-weight: 500;
  color: var(--primary); text-decoration: underline; text-underline-offset: 2px;
}
.link-btn:hover { color: var(--primary-hover); }
.link-btn:disabled { opacity: .45; cursor: default; }
main section.quick-report details.options { margin-top: 10px; }
main section.quick-report details.options summary { display: list-item; color: var(--primary); font-weight: 500; cursor: pointer; }

.filter-bar {
  display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 12px 0 4px;
  padding: 8px 12px; background: var(--primary-softer); border: 1px solid var(--primary-soft); border-radius: var(--radius-sm); font-size: 12px;
}

/* reminder bubble above the launcher */
.launcher-hint {
  position: fixed; right: 22px; bottom: 82px; z-index: 2147483647; max-width: 300px;
  display: flex; align-items: center; gap: 10px; padding: 10px 10px 10px 14px;
  background: var(--bg); color: var(--text); border: 1px solid var(--primary-soft); border-radius: 14px;
  box-shadow: 0 10px 30px rgba(52, 2, 84, .22); font-size: 12.5px; line-height: 1.4;
  animation: gtmqa-hint-in .25s ease-out;
}
.launcher-hint[hidden] { display: none; }
.launcher-hint::after {
  content: ''; position: absolute; right: 34px; bottom: -7px; width: 12px; height: 12px;
  background: var(--bg); border-right: 1px solid var(--primary-soft); border-bottom: 1px solid var(--primary-soft);
  transform: rotate(45deg);
}
.launcher-hint .hint-text { flex: 1; }
.launcher-hint .hint-close {
  border: none; background: transparent; color: var(--muted); cursor: pointer; font-size: 16px; line-height: 1;
  padding: 2px 4px; border-radius: 6px;
}
.launcher-hint .hint-close:hover { background: var(--bg-muted); color: var(--text); }
@keyframes gtmqa-hint-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
.launcher:hover { transform: translateY(-2px); box-shadow: 0 10px 24px rgba(52, 2, 84, .4); }

.panel {
  position: fixed; top: 0; right: 0; z-index: 2147483647;
  width: 460px; max-width: 100vw; height: 100vh;
  display: flex; flex-direction: column;
  background: var(--bg-soft); border-left: 1px solid var(--border);
  box-shadow: -8px 0 30px rgba(17, 24, 39, .14);
}
.panel[hidden] { display: none; }

header {
  padding: 14px 16px; display: flex; align-items: center; gap: 10px;
  background: var(--gradient); color: #fff;
}
header .brand-mark { width: 26px; height: 32px; flex: none; display: block; }
header .brand-mark svg { width: 100%; height: 100%; display: block; }
header .title { font-size: 15px; font-weight: 700; letter-spacing: -.01em; }
header .ctx { color: rgba(255, 255, 255, .78); font-size: 12px; margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
header .grow { flex: 1; min-width: 0; }
.icon-btn {
  border: none; background: transparent; cursor: pointer; font-size: 20px; line-height: 1;
  color: rgba(255, 255, 255, .85); padding: 4px 8px; border-radius: var(--radius-sm);
}
.icon-btn:hover { background: rgba(255, 255, 255, .16); color: #fff; }

.lang-switch { display: flex; gap: 2px; padding: 2px; background: rgba(255, 255, 255, .14); border-radius: 999px; }
.lang-switch button {
  border: none; background: transparent; color: rgba(255, 255, 255, .85); cursor: pointer;
  font-family: inherit; font-size: 11px; font-weight: 600; line-height: 1; padding: 5px 9px; border-radius: 999px;
}
.lang-switch button:hover { background: rgba(255, 255, 255, .14); color: #fff; }
.lang-switch button.active { background: #fff; color: var(--primary); }

nav {
  display: flex; gap: 2px; padding: 0 8px; background: var(--bg);
  border-bottom: 1px solid var(--border); overflow-x: auto;
}
nav button {
  flex: 1; padding: 11px 8px 9px; border: none; background: none; cursor: pointer;
  font: inherit; font-weight: 500; color: var(--muted); border-bottom: 2px solid transparent; white-space: nowrap;
  transition: color .12s ease, border-color .12s ease;
}
nav button:hover { color: var(--primary); }
nav button[aria-selected="true"] { color: var(--primary); border-bottom-color: var(--primary); font-weight: 600; }

main { flex: 1; overflow-y: auto; padding: 14px; }
main section {
  background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius);
  padding: 14px; box-shadow: var(--shadow-sm);
}
section + section { margin-top: 12px; }
main section.plain { background: transparent; border: none; box-shadow: none; padding: 0; }
main section section { border: none; box-shadow: none; padding: 0; background: transparent; margin-top: 12px; }
h3 {
  font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .07em;
  color: var(--primary); margin: 0 0 10px;
}
p { margin: 0 0 8px; }
.muted { color: var(--muted); }
.small { font-size: 12px; }
strong { font-weight: 600; }

/* --- key/value, tables, lists ------------------------------------------------ */

.kv { display: grid; grid-template-columns: max-content 1fr; gap: 4px 14px; }
.kv dt { color: var(--muted); }
.kv dd { margin: 0; font-family: ui-monospace, 'Cascadia Code', Consolas, monospace; font-size: 12px; color: var(--text-2); }

table { width: 100%; border-collapse: separate; border-spacing: 0; }
th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
th {
  font-weight: 600; color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .05em;
  background: var(--bg-soft);
}
th:first-child { border-top-left-radius: var(--radius-sm); }
th:last-child { border-top-right-radius: var(--radius-sm); }
tbody tr:last-child td { border-bottom: none; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
tr.clickable { cursor: pointer; }
tr.clickable:hover td { background: var(--primary-softer); }
tr.selected td { background: var(--primary-soft); }

.list { list-style: none; margin: 0; padding: 0; }
.list li { padding: 7px 0; border-bottom: 1px solid var(--bg-muted); display: flex; gap: 8px; justify-content: space-between; align-items: center; }
.list li:last-child { border-bottom: none; }
.list li .name { overflow-wrap: anywhere; }
.list li .type { color: var(--muted); font-size: 12px; white-space: nowrap; }

details { border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 8px 12px; background: var(--bg); }
details + details { margin-top: 8px; }
summary { cursor: pointer; font-weight: 600; list-style-position: outside; }
summary::marker { color: var(--primary-light); }
details[open] > summary { margin-bottom: 6px; }

/* --- controls ------------------------------------------------------------------ */

.row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.row.spread { justify-content: space-between; }
.row.spread h3 { margin: 0; }

button.btn {
  font: inherit; font-weight: 600; padding: 7px 14px; border-radius: 999px; cursor: pointer;
  border: 1px solid var(--border-strong); background: var(--bg); color: var(--primary);
  transition: background .12s ease, border-color .12s ease, box-shadow .12s ease;
}
button.btn:hover { background: var(--primary-softer); border-color: var(--primary-light); }
button.btn.primary { background: var(--primary); border-color: var(--primary); color: #fff; box-shadow: 0 2px 6px rgba(52, 2, 84, .25); }
button.btn.primary:hover { background: var(--primary-hover); border-color: var(--primary-hover); }
button.btn:disabled { opacity: .45; cursor: default; box-shadow: none; }
button.btn.small { padding: 3px 10px; font-size: 12px; }
button.btn:focus-visible, nav button:focus-visible, .lang-switch button:focus-visible {
  outline: 2px solid var(--accent); outline-offset: 2px;
}

label { display: block; font-weight: 600; font-size: 12px; color: var(--text-2); margin: 12px 0 5px; }
label.inline { display: flex; gap: 8px; align-items: center; font-weight: 400; font-size: 13px; color: var(--text); }
input[type=text], input[type=password], input[type=url], select, textarea {
  width: 100%; font: inherit; padding: 8px 10px; border: 1px solid var(--border-strong); border-radius: var(--radius-sm);
  background: var(--bg); color: var(--text); transition: border-color .12s ease, box-shadow .12s ease;
}
input:focus, select:focus, textarea:focus { outline: none; border-color: var(--primary-light); box-shadow: 0 0 0 3px var(--primary-soft); }
input[type=checkbox] { accent-color: var(--primary); width: 15px; height: 15px; }
textarea { min-height: 60px; resize: vertical; font-family: ui-monospace, 'Cascadia Code', Consolas, monospace; font-size: 12px; }

.note {
  background: var(--primary-softer); border: 1px solid var(--primary-soft); border-left: 3px solid var(--primary-light);
  border-radius: var(--radius-sm); padding: 9px 11px; font-size: 12px; margin-top: 10px; color: var(--text-2);
}
.status { font-size: 12px; margin-top: 10px; min-height: 1em; color: var(--muted); }
.status:empty { margin-top: 0; }
.status.ok { color: var(--ok); }
.status.err { color: var(--crit); }

.badge {
  display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; line-height: 1.6;
  background: var(--bg-muted); color: var(--muted); white-space: nowrap;
}
.badge.ok { background: var(--ok-soft); color: var(--ok); }
.badge.warn { background: var(--warn-soft); color: var(--warn); }
.badge.crit { background: var(--crit-soft); color: var(--crit); }
.badge + .badge { margin-left: 4px; }

.empty { padding: 28px 10px; text-align: center; color: var(--muted); }

/* --- data tab -------------------------------------------------------------------- */

.list li.entity { display: block; padding: 0; }
details.plain { border: none; padding: 6px 0; background: transparent; }
details.plain summary { font-weight: 400; display: flex; gap: 6px; align-items: baseline; }
details.plain summary .type { margin-left: auto; }

/* --- debug tab -------------------------------------------------------------------- */

.capture { padding: 8px 0; border-bottom: 1px solid var(--bg-muted); font-size: 12px; }
.capture .url { font-family: ui-monospace, Consolas, monospace; overflow-wrap: anywhere; color: var(--text-2); }
.capture .meta { color: var(--muted); display: flex; gap: 8px; flex-wrap: wrap; margin-top: 3px; }

/* --- diff tab ---------------------------------------------------------------------- */

details.diff-entity { padding: 8px 12px; border-left: 3px solid var(--border-strong); }
details.diff-entity:has(.badge.ok) { border-left-color: var(--ok-line); }
details.diff-entity:has(.badge.warn) { border-left-color: var(--warn-line); }
details.diff-entity:has(.badge.crit) { border-left-color: var(--crit-line); }
details.diff-entity summary { font-weight: 500; display: flex; gap: 8px; align-items: baseline; }
details.diff-entity summary .name { overflow-wrap: anywhere; }
details.diff-entity summary .type { margin-left: auto; color: var(--muted); font-size: 12px; white-space: nowrap; font-weight: 400; }
table.fields { margin-top: 8px; table-layout: fixed; }
table.fields th:first-child, table.fields td:first-child { width: 28%; overflow-wrap: anywhere; font-size: 12px; }
pre.val {
  margin: 0; padding: 5px 8px; border-radius: var(--radius-sm); max-height: 180px; overflow: auto;
  font: 11px/1.45 ui-monospace, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere;
}
pre.val.before { background: var(--crit-soft); color: #7f1d1d; }
pre.val.after { background: var(--ok-soft); color: #064e3b; }

/* --- QA tab ------------------------------------------------------------------------ */

.tiles { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 4px; }
.tile {
  display: flex; flex-direction: column; gap: 2px; padding: 10px 12px; margin: 0;
  border-radius: var(--radius); border: 1px solid var(--border); background: var(--bg);
  cursor: pointer; user-select: none; transition: opacity .12s ease, transform .12s ease;
}
.tile:hover { transform: translateY(-1px); }
.tile input { position: absolute; opacity: 0; pointer-events: none; }
.tile .count { font-size: 22px; font-weight: 700; line-height: 1.1; font-variant-numeric: tabular-nums; }
.tile .label { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; }
.tile.critical { background: var(--crit-soft); border-color: #fecaca; color: var(--crit); }
.tile.warning { background: var(--warn-soft); border-color: #fde68a; color: var(--warn); }
.tile.info { background: var(--info-soft); border-color: #bfdbfe; color: var(--info); }
.tile.off { opacity: .4; }

details.finding {
  border-left-width: 4px; border-radius: var(--radius-sm); padding: 10px 12px;
  box-shadow: var(--shadow-sm);
}
details.finding + details.finding { margin-top: 8px; }
details.finding.critical { border-left-color: var(--crit-line); }
details.finding.warning { border-left-color: var(--warn-line); }
details.finding.info { border-left-color: var(--info-line); }
details.finding summary { font-weight: 500; display: flex; gap: 8px; align-items: baseline; }
details.finding p { margin: 6px 0; color: var(--text-2); }
details.finding > button.btn.small { margin-top: 6px; }
.chips { display: flex; flex-wrap: wrap; gap: 4px; margin: 6px 0; }
.chip { font-size: 11px; padding: 2px 9px; border-radius: 999px; background: var(--primary-soft); color: var(--primary); font-weight: 500; }
.fixes { margin: 8px 0; padding: 10px 12px; background: var(--bg-soft); border: 1px solid var(--bg-muted); border-radius: var(--radius-sm); max-height: 340px; overflow: auto; }
.fixes-title { font-weight: 600; color: var(--primary); }
.fix { display: grid; grid-template-columns: 1fr auto; gap: 2px 8px; align-items: center; padding: 7px 0; border-top: 1px solid var(--bg-muted); }
.fix:first-of-type { border-top: 0; }
.fix-names { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px; min-width: 0; overflow-wrap: anywhere; }
.fix-old { color: var(--text-2); text-decoration: line-through; text-decoration-color: #ef4444; }
.fix-arrow { color: var(--text-2); }
.fix-new { font: 600 12px/1.4 ui-monospace, Consolas, monospace; color: #15803d; background: #dcfce7; padding: 1px 6px; border-radius: 4px; }
.fix-reason { grid-column: 1 / -1; font-size: 11px; color: var(--text-2); }
.exception-form textarea { font-family: inherit; font-size: 13px; min-height: 54px; }
.exception-form {
  margin-top: 8px; padding: 10px 12px; background: var(--primary-softer);
  border: 1px dashed var(--primary-light); border-radius: var(--radius-sm);
}

/* --- report tab ---------------------------------------------------------------------- */

textarea.report { min-height: 440px; font-size: 11.5px; line-height: 1.5; background: var(--bg-soft); }

pre.params {
  margin: 6px 0; padding: 9px 10px; background: var(--bg-soft); border: 1px solid var(--bg-muted); border-radius: var(--radius-sm);
  font: 11px/1.5 ui-monospace, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--text-2);
  max-height: 260px; overflow: auto;
}

/* thin scrollbars inside the panel */
main::-webkit-scrollbar, pre::-webkit-scrollbar, textarea::-webkit-scrollbar { width: 8px; height: 8px; }
main::-webkit-scrollbar-thumb, pre::-webkit-scrollbar-thumb, textarea::-webkit-scrollbar-thumb { background: #d4c8e6; border-radius: 8px; }
main::-webkit-scrollbar-track, pre::-webkit-scrollbar-track, textarea::-webkit-scrollbar-track { background: transparent; }
`;

/** smarketer group mark (from the official logo), recoloured for the dark header. Static markup only. */
export const BRAND_MARK_SVG = `<svg viewBox="55 35 245 330" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
<path d="m294 282-234-84v-60l234 84z" fill="#ffffff"/>
<path d="m258 120-198 78v-60l198-78z" fill="#ae93d6"/>
<path d="m294 222-234 78v60l234-78z" fill="#ffffff" fill-opacity=".72"/>
</svg>`;

/**
 * Inter ships with the extension (OFL). @font-face must live in the document, not the shadow root;
 * GTM's CSP restricts scripts only, so extension-hosted fonts load fine.
 */
export function installFonts(): void {
  if (document.getElementById('gtm-qa-checker-fonts')) return;
  const url = (file: string) => chrome.runtime.getURL(`fonts/${file}`);
  const style = document.createElement('style');
  style.id = 'gtm-qa-checker-fonts';
  style.textContent = `
@font-face { font-family: 'GtmQaInter'; font-style: normal; font-display: swap; font-weight: 100 900;
  src: url(${url('inter-latin-ext-wght-normal.woff2')}) format('woff2-variations');
  unicode-range: U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF; }
@font-face { font-family: 'GtmQaInter'; font-style: normal; font-display: swap; font-weight: 100 900;
  src: url(${url('inter-latin-wght-normal.woff2')}) format('woff2-variations');
  unicode-range: U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD; }`;
  document.head.append(style);
}
