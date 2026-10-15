// Isolated-world content script: receives captures from injected.js, runs them through
// the adapter, keeps the store and mounts the Shadow DOM panel.
import { countExtracted, extractEntities, parseContext, parseResponseText, scopeFromUrl } from '../adapters/gtmApiAdapter';
import type { DiffRequest, DiffResult } from '../diff/diffEngine';
import { computeDiff, runDiff } from '../diff/diffService';
import { defineMessages, setLang, type Lang } from '../i18n';
import type { LintResult } from '../qa/linter';
import { computeLint, runQa, type LintRequest } from '../qa/qaService';
import { applySuppressions } from '../qa/suppress';
import { loadExceptions } from '../shared/exceptions';
import type { CaptureVia, RuntimeMsg } from '../shared/messages';
import { loadSettings, saveSettings } from '../shared/storage';
import type { DetectedCounts } from '../shared/types';
import { InjectedBridge } from './bridge';
import { CaptureLog } from './captureLog';
import { GtmLoader, type Progress } from './loader';
import { Panel } from './panel/panel';
import { GtmStore } from './store';

const t = defineMessages({
  en: {
    noBody: 'empty response',
    invalidJson: 'The file is not valid JSON.',
    notExport: 'This is not a GTM container export (no exportFormatVersion).',
  },
  de: {
    noBody: 'leere Antwort',
    invalidJson: 'Die Datei ist kein gültiges JSON.',
    notExport: 'Das ist kein GTM-Containerexport (kein exportFormatVersion).',
  },
  pl: {
    noBody: 'brak treści',
    invalidJson: 'Plik nie jest poprawnym JSON-em.',
    notExport: 'To nie jest eksport kontenera GTM (brak exportFormatVersion).',
  },
});

export interface Controller {
  store: GtmStore;
  log: CaptureLog;
  loadVersionList(): Promise<void>;
  loadWorkspace(workspaceId: string, onProgress?: (p: Progress) => void): Promise<void>;
  loadVersion(versionId: string, onProgress?: (p: Progress) => void): Promise<void>;
  runDiff(req: DiffRequest, onProgress: (p: Progress) => void): Promise<DiffResult>;
  /** Most recent diff, reused by the QA and report tabs. */
  lastDiff: DiffResult | null;
  runQa(req: LintRequest, onProgress: (p: Progress) => void): Promise<LintResult>;
  /** Most recent QA result, reused by the report tab. */
  lastLint: LintResult | null;
  /** Re-applies stored exceptions to lastLint (after adding/removing one). */
  reapplyExceptions(): Promise<void>;
  /** Switches the language and re-computes the last diff/QA from memory (no GTM requests). */
  setLanguage(lang: Lang): Promise<void>;
  /** Manual read-only GET (Debug tab), e.g. to explore GTM's internal endpoints. */
  fetchUrl(url: string): Promise<{ ok: boolean; status: number; error?: string; detected?: DetectedCounts }>;
  importExportFile(file: File): Promise<DetectedCounts>;
}

const store = new GtmStore();
const log = new CaptureLog();

function processResponse(url: string, method: string, status: number, via: CaptureVia, text: string): DetectedCounts {
  const body = parseResponseText(text);
  const extracted = body === undefined ? null : extractEntities(body);
  const detected = extracted ? countExtracted(extracted) : { tags: 0, triggers: 0, variables: 0, versions: 0, headers: 0 };
  if (extracted && status >= 200 && status < 300) store.ingest(extracted, scopeFromUrl(url));
  log.add({ url, method, status, via, ts: Date.now(), size: text.length, parsed: body !== undefined, detected, text });
  return detected;
}

const bridge = new InjectedBridge((msg) => processResponse(msg.url, msg.method, msg.status, msg.via, msg.text));

async function get(url: string): Promise<void> {
  const res = await bridge.fetch(url);
  if (res.text !== undefined) processResponse(res.url, 'GET', res.status, 'active', res.text);
  if (!res.ok) throw new Error(`GET ${url}: ${res.error ?? `HTTP ${res.status}`}`);
}

const loader = new GtmLoader(store, get);

// Requests behind lastDiff / lastLint, so they can be re-computed in another language.
let lastDiffRequest: DiffRequest | null = null;
let lastLintRequest: { scope: LintRequest['scope']; onlyChanged: boolean } | null = null;

const controller: Controller = {
  store,
  log,
  loadVersionList: () => loader.loadVersionList(),
  loadWorkspace: (workspaceId, onProgress) => loader.loadWorkspace(workspaceId, onProgress),
  loadVersion: (versionId, onProgress) => loader.loadVersion(versionId, onProgress),
  lastDiff: null,
  async runDiff(req, onProgress) {
    const result = await store.batch(() => runDiff(req, store, loader, onProgress));
    this.lastDiff = result;
    lastDiffRequest = req;
    return result;
  },
  lastLint: null,
  async reapplyExceptions() {
    if (!this.lastLint) return;
    const { suppressions } = await loadExceptions();
    this.lastLint = applySuppressions(this.lastLint, suppressions, store.context.containerId);
  },
  async runQa(req, onProgress) {
    const result = await store.batch(() => runQa(req, store, loader, onProgress));
    this.lastLint = result;
    lastLintRequest = { scope: req.scope, onlyChanged: !!req.onlyChangedIn };
    return result;
  },
  async setLanguage(lang) {
    setLang(lang);
    await saveSettings({ language: lang });
    store.relabel();
    // Findings and diff labels are generated text: rebuild them in the new language.
    if (this.lastDiff && lastDiffRequest) this.lastDiff = computeDiff(lastDiffRequest, store);
    if (this.lastLint && lastLintRequest) {
      const onlyChangedIn = lastLintRequest.onlyChanged && this.lastDiff ? this.lastDiff : undefined;
      this.lastLint = await computeLint({ scope: lastLintRequest.scope, onlyChangedIn }, store);
    }
  },
  async fetchUrl(url) {
    const res = await bridge.fetch(url);
    if (res.text === undefined) return { ok: false, status: res.status, error: res.error ?? t('noBody') };
    const detected = processResponse(res.url, 'GET', res.status, 'active', res.text);
    return { ok: res.ok, status: res.status, detected };
  },
  async importExportFile(file) {
    const body = parseResponseText(await file.text());
    if (body === undefined) throw new Error(t('invalidJson'));
    const extracted = extractEntities(body);
    if (!extracted.isExportFile) throw new Error(t('notExport'));
    store.ingest(extracted, null, file.name);
    return countExtracted(extracted);
  },
};

// GTM is a single-page app: keep the context in sync with the hash route.
const syncContext = () => {
  const before = store.context.containerId;
  store.setContext(parseContext(location.href));
  // Results belong to the previous container – drop them so nothing is shown or re-used in the new one.
  if (before && store.context.containerId !== before) {
    controller.lastDiff = null;
    controller.lastLint = null;
    lastDiffRequest = null;
    lastLintRequest = null;
  }
};
syncContext();
window.addEventListener('hashchange', syncContext);
window.addEventListener('popstate', syncContext);
setInterval(syncContext, 1500);

// The language must be known before the first render.
const ready = loadSettings().then((s) => setLang(s.language));

let panel: Panel | null = null;
async function mountPanel(): Promise<Panel> {
  await ready;
  panel ??= new Panel(controller);
  return panel;
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => void mountPanel(), { once: true });
else void mountPanel();

chrome.runtime.onMessage.addListener((msg: RuntimeMsg) => {
  if (msg.type === 'panel:toggle') void mountPanel().then((p) => p.toggle());
});
