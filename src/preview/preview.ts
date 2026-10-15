// Content script for Tag Assistant (GTM Preview, tagassistant.google.com) – an ongoing audit:
//  - every new event is checked automatically while the user is idle: the script briefly selects the
//    event in Tag Assistant, reads the tags (and for relevant events the variables and dataLayer),
//    runs live checks and returns to what the user was looking at;
//  - relevant events (tags fired) are reviewed by AI in batches;
//  - tag tiles are coloured with dots from the container QA (GTM tab), the live checks and the AI;
//    events on the left get a dot with their worst finding; the card lists everything to fix.
// Read-only: it only reads what Tag Assistant renders and clicks Tag Assistant's own navigation.
import { h } from '../content/panel/dom';
import { BRAND_MARK_SVG, installFonts } from '../content/panel/styles';
import { defineMessages, getLang, isLang, setLang } from '../i18n';
import type { LlmResponse, RuntimeMsg } from '../shared/messages';
import { addAiRule, addFeedback, loadExceptions } from '../shared/exceptions';
import { loadPreviewQa, previewQaKey, type MarkCounts, type PreviewQa } from '../shared/previewQa';
import { loadSettings } from '../shared/storage';

type Severity = 'critical' | 'warning' | 'info';
const SEVERITIES: Severity[] = ['critical', 'warning', 'info'];
const COLORS: Record<Severity, string> = { critical: '#ef4444', warning: '#f59e0b', info: '#3b82f6' };
const TINTS: Record<Severity, string> = { critical: '#fef2f2', warning: '#fffbeb', info: '#eff6ff' };
const ICONS: Record<Severity, string> = { critical: '🔴', warning: '🟡', info: '🔵' };
const BADGE_ATTR = 'data-gtmqa-badge';
const TILE_ATTR = 'data-gtmqa-tile';

/** Events without tags by design – not opened by the audit. */
const SKIP_EVENTS = /^(set|message)$/i;
/** Events not sent to the AI even when tags fired (consent plumbing). */
const NO_AI_EVENTS = /^(consent (default|update|initialization)|initialization|gtm_consent_default|set)$/i;
/** Variables always sent to the AI (values that matter for conversions). */
const RELEVANT_VAR = /value|revenue|umsatz|wert|price|preis|currency|w(ä|ae)hrung|transaction|order|bestell|items|produkt|product|event|conversion|label|id$|consent|tax|steuer|shipping|versand|coupon|gutschein|user_data|enhanced/i;
const IDLE_MS = 1800;
const AI_DEBOUNCE_MS = 3000;
const AI_BATCH = 8;
const AI_MAX_REQUESTS = 15;

const t = defineMessages({
  en: {
    title: 'smarketer QA · Preview',
    qaNone: 'No QA result for {id} yet – open the container in GTM and click "Run QA" to add the container findings.',
    qaFrom: 'Container QA ({scope}, {time}): {c} critical · {w} warnings · {i} info',
    auditStatus: 'Live audit: {done}/{total} events checked · AI: {ai} reviewed',
    auditRunning: 'Checking event {name}…',
    aiRunning: 'AI ({provider}) is reviewing {n} event(s)…',
    aiOff: 'Automatic AI review is off (Settings).',
    aiLimit: 'Automatic AI review paused after {n} requests.',
    aiResume: 'Continue',
    aiNoKey: 'No API key in the extension settings – AI review is skipped.',
    issuesTitle: 'To check',
    noIssues: 'No problems found so far.',
    qaTagsTitle: 'Container QA – tags in this view',
    fired: 'fired',
    notFired: 'not fired',
    blocked: 'blocked by consent',
    failed: 'Tag failed',
    firedTimes: 'Fired {n}× in one event – duplicate hits / conversions?',
    consent: 'Blocked by consent settings (expected until consent is given)',
    noTagsConversion: 'Looks like a conversion event, but no tag fired',
    aiButton: 'Review this event with AI now',
    aiNote: 'AI receives tag names, relevant variable values (e-mails / phone numbers masked) and the dataLayer.',
    aiBadAnswer: 'The AI answer could not be read.',
    noSw: 'No response from the extension – reload the page.',
    legend: 'red = error · yellow = to fix · blue = info. The audit runs while you do not click in Tag Assistant.',
    tipQa: 'Container QA:',
    tipEvent: 'This event:',
    collapse: 'Collapse',
    fbCorrect: '👍 Correct',
    fbWrong: '👎 Not correct – why?',
    fbWhyOk: 'Why is it a real problem? (optional)',
    fbPlaceholderOk: 'e.g. conversion would be counted twice in Google Ads…',
    aiRuleTextOk: 'Preview audit: "{finding}"{tag} at the event "{event}" is a real problem and must be reported – {reason}',
    fbWhy: 'Why is this not correct?',
    fbPlaceholder: 'e.g. this tag must fire on every page, the pixel is in the page code…',
    fbTeach: 'Also teach the AI (adds a rule)',
    fbSave: 'Save',
    fbCancel: 'Cancel',
    fbConfirmed: '✓ Confirmed as a problem',
    aiRuleText: 'Preview audit: "{finding}"{tag} at the event "{event}" is not an error – {reason}',
    more: '… and {n} more',
  },
  de: {
    title: 'smarketer QA · Vorschau',
    qaNone: 'Noch kein QA-Ergebnis für {id} – Container in GTM öffnen und „QA starten“ klicken, um die Container-Befunde zu ergänzen.',
    qaFrom: 'Container-QA ({scope}, {time}): {c} kritisch · {w} Warnungen · {i} Hinweise',
    auditStatus: 'Live-Audit: {done}/{total} Ereignisse geprüft · KI: {ai} geprüft',
    auditRunning: 'Prüfe Ereignis {name}…',
    aiRunning: 'KI ({provider}) prüft {n} Ereignis(se)…',
    aiOff: 'Automatische KI-Prüfung ist aus (Einstellungen).',
    aiLimit: 'Automatische KI-Prüfung nach {n} Anfragen pausiert.',
    aiResume: 'Fortsetzen',
    aiNoKey: 'Kein API-Schlüssel in den Einstellungen – KI-Prüfung wird übersprungen.',
    issuesTitle: 'Zu prüfen',
    noIssues: 'Bisher keine Probleme gefunden.',
    qaTagsTitle: 'Container-QA – Tags in dieser Ansicht',
    fired: 'ausgelöst',
    notFired: 'nicht ausgelöst',
    blocked: 'durch Einwilligung blockiert',
    failed: 'Tag fehlgeschlagen',
    firedTimes: '{n}× bei einem Ereignis ausgelöst – doppelte Hits / Conversions?',
    consent: 'Durch Einwilligungseinstellungen blockiert (bis zur Einwilligung erwartet)',
    noTagsConversion: 'Sieht nach einem Conversion-Ereignis aus, aber kein Tag wurde ausgelöst',
    aiButton: 'Dieses Ereignis jetzt mit KI prüfen',
    aiNote: 'Die KI erhält Tag-Namen, relevante Variablenwerte (E-Mails / Telefonnummern maskiert) und die Datenschicht.',
    aiBadAnswer: 'Die KI-Antwort konnte nicht gelesen werden.',
    noSw: 'Keine Antwort der Erweiterung – Seite neu laden.',
    legend: 'rot = Fehler · gelb = zu beheben · blau = Hinweis. Das Audit läuft, solange Sie nicht in Tag Assistant klicken.',
    tipQa: 'Container-QA:',
    tipEvent: 'Dieses Ereignis:',
    collapse: 'Einklappen',
    fbCorrect: '👍 Richtig',
    fbWrong: '👎 Nicht richtig – warum?',
    fbWhyOk: 'Warum ist das ein echtes Problem? (optional)',
    fbPlaceholderOk: 'z. B. die Conversion würde in Google Ads doppelt gezählt…',
    aiRuleTextOk: 'Vorschau-Audit: „{finding}“{tag} beim Ereignis „{event}“ ist ein echtes Problem und muss gemeldet werden – {reason}',
    fbWhy: 'Warum ist das nicht richtig?',
    fbPlaceholder: 'z. B. dieses Tag muss auf jeder Seite feuern, das Pixel ist im Seitencode…',
    fbTeach: 'Auch der KI beibringen (fügt eine Regel hinzu)',
    fbSave: 'Speichern',
    fbCancel: 'Abbrechen',
    fbConfirmed: '✓ Als Problem bestätigt',
    aiRuleText: 'Vorschau-Audit: „{finding}“{tag} beim Ereignis „{event}“ ist kein Fehler – {reason}',
    more: '… und {n} weitere',
  },
  pl: {
    title: 'smarketer QA · Preview',
    qaNone: 'Brak wyniku QA dla {id} – otwórz kontener w GTM i kliknij „Uruchom QA”, aby dodać uwagi z kontenera.',
    qaFrom: 'QA kontenera ({scope}, {time}): {c} krytyczne · {w} ostrzeżenia · {i} info',
    auditStatus: 'Audyt na żywo: {done}/{total} zdarzeń sprawdzonych · AI: {ai} przejrzanych',
    auditRunning: 'Sprawdzam zdarzenie {name}…',
    aiRunning: 'AI ({provider}) sprawdza {n} zdarzenie(a)…',
    aiOff: 'Automatyczne sprawdzanie przez AI jest wyłączone (Ustawienia).',
    aiLimit: 'Automatyczne AI wstrzymane po {n} zapytaniach.',
    aiResume: 'Kontynuuj',
    aiNoKey: 'Brak klucza API w ustawieniach rozszerzenia – sprawdzanie przez AI pominięte.',
    issuesTitle: 'Do sprawdzenia',
    noIssues: 'Na razie nie znaleziono problemów.',
    qaTagsTitle: 'QA kontenera – tagi w tym widoku',
    fired: 'odpalony',
    notFired: 'nie odpalony',
    blocked: 'zablokowany przez zgody',
    failed: 'Tag zakończył się błędem',
    firedTimes: 'Odpalony {n}× w jednym zdarzeniu – zdublowane hity / konwersje?',
    consent: 'Zablokowany przez ustawienia zgód (oczekiwane do czasu zgody)',
    noTagsConversion: 'Wygląda na zdarzenie konwersji, ale żaden tag nie odpalił',
    aiButton: 'Sprawdź teraz to zdarzenie z AI',
    aiNote: 'AI dostaje nazwy tagów, istotne wartości zmiennych (e-maile / telefony zamaskowane) i dataLayer.',
    aiBadAnswer: 'Nie udało się odczytać odpowiedzi AI.',
    noSw: 'Brak odpowiedzi rozszerzenia – przeładuj stronę.',
    legend: 'czerwony = błąd · żółty = do poprawy · niebieski = info. Audyt działa, gdy nie klikasz w Tag Assistancie.',
    tipQa: 'QA kontenera:',
    tipEvent: 'To zdarzenie:',
    collapse: 'Zwiń',
    fbCorrect: '👍 Poprawne',
    fbWrong: '👎 Niepoprawne – dlaczego?',
    fbWhyOk: 'Dlaczego to realny problem? (opcjonalnie)',
    fbPlaceholderOk: 'np. konwersja liczyłaby się podwójnie w Google Ads…',
    aiRuleTextOk: 'Audyt Preview: „{finding}”{tag} przy zdarzeniu „{event}” to realny problem i należy go zgłaszać – {reason}',
    fbWhy: 'Dlaczego to nie jest poprawne?',
    fbPlaceholder: 'np. ten tag ma odpalać na każdej stronie, piksel jest w kodzie strony…',
    fbTeach: 'Naucz też AI (dodaje zasadę)',
    fbSave: 'Zapisz',
    fbCancel: 'Anuluj',
    fbConfirmed: '✓ Potwierdzone jako problem',
    aiRuleText: 'Audyt Preview: „{finding}”{tag} przy zdarzeniu „{event}” nie jest błędem – {reason}',
    more: '… i {n} więcej',
  },
});

interface Tile {
  el: HTMLElement;
  titleEl: HTMLElement;
  name: string;
  type: string;
  status: string;
  section: 'fired' | 'consent' | 'notFired';
}

interface Note {
  severity: Severity;
  event: string;
  tag: string | null;
  text: string;
  fix?: string;
  source: 'live' | 'ai';
  /** Live-check kind (failed, firedTimes, consent, noTags) or "ai". */
  kind: string;
}

type Verdict = 'correct' | 'wrong';
const noteId = (n: Note) => [n.event, n.tag ?? '', n.kind, n.text].join('|');

interface EventData {
  event: string;
  fired: { name: string; type: string; status?: string }[];
  blockedByConsent: string[];
  notFired: string[];
  variables?: Record<string, string>;
  undefinedVariables?: string[];
  dataLayer?: string;
}

interface Audit {
  key: string;
  live: Note[];
  ai: Note[];
  data?: EventData;
  aiDone?: boolean;
  aiWanted: boolean;
  /** Identity of the event's setup for the AI cache (same event + tags + variables = same answer). */
  fp?: string;
}

interface CachedAi {
  at: number;
  items: Pick<Note, 'severity' | 'tag' | 'text' | 'fix'>[];
}

const AI_CACHE_MAX = 150;

/** Same event name, same tags and the same set of relevant variables → the AI answer is reused. */
function fingerprint(d: EventData): string {
  return JSON.stringify([
    eventName(d.event),
    d.fired.map((x) => `${x.name}:${(x.status ?? '').replace(/\d+/g, '#')}`).sort(),
    [...d.blockedByConsent].sort(),
    Object.keys(d.variables ?? {}).filter((n) => RELEVANT_VAR.test(n)).sort(),
    [...(d.undefinedVariables ?? [])].sort(),
  ]);
}

/** Element text without our own markers. */
function ownText(el: Element): string {
  return [...el.childNodes]
    .filter((n) => !(n instanceof HTMLElement && n.hasAttribute(BADGE_ATTR)))
    .map((n) => n.textContent ?? '')
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "23 Click" -> "Click" */
const eventName = (key: string) => key.replace(/^\d+\s+/, '');
const worstOf = (notes: { severity: Severity }[]) => SEVERITIES.find((s) => notes.some((n) => n.severity === s));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- masking for the AI payload -------------------------------------------------------------------
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE = /(\+\d[\d\s\-()/]{6,}\d)|(\b0\d{2,5}[\s\-/]\d[\d\s\-/]{4,}\d)/g;
const PERSONAL = /e-?mail|phone|telefon|\btel\b|mobile|handy|first.?name|last.?name|vorname|nachname|address|adresse|street|stra(ss|ß)e|\bzip\b|\bplz\b|postal|city|stadt|birth|geburt/i;
const mask = (s: string, max = 200) => {
  const clean = s.replace(EMAIL, '[email]').replace(PHONE, '[phone]');
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
};

class PreviewAuditor {
  private readonly host = document.createElement('div');
  private readonly root: ShadowRoot;
  private readonly publicId = location.hash.match(/[?&]id=(GTM-[A-Z0-9]+)/)?.[1] ?? null;
  private qa: PreviewQa | null = null;
  private readonly audits = new Map<string, Audit>();
  private open = sessionStorage.getItem('gtmqa-preview-open') !== '0';
  private provider = '';
  private hasKey = false;
  private autoAi = true;
  private aiRequests = 0;
  private aiRunning = 0;
  private aiError = '';
  private aiTimer: ReturnType<typeof setTimeout> | undefined;
  private lastUserInput = 0;
  private auditing: string | null = null;
  private scheduled = false;
  private cardSignature = '';
  /** Feedback given in this session (note id -> verdict). */
  private readonly verdicts = new Map<string, Verdict>();
  /** "tag|kind" of live checks marked not correct for this container. */
  private liveSuppressed = new Set<string>();
  /** "tag|finding" of AI notes marked not correct for this container. */
  private aiSuppressed = new Set<string>();
  private aiCache: Record<string, CachedAi> = {};
  /** Note whose "why not correct" form is open; the card is not re-rendered meanwhile. */
  private formFor: { id: string; verdict: Verdict } | null = null;
  private draft = '';

  constructor() {
    this.host.id = 'gtm-qa-preview-host';
    this.root = this.host.attachShadow({ mode: 'open' });
    installFonts();
    new MutationObserver(() => this.schedule()).observe(document.documentElement, { childList: true, subtree: true });
    // Real user input pauses the audit (our own .click() calls are not trusted events).
    for (const type of ['pointerdown', 'keydown', 'wheel']) {
      document.addEventListener(type, (e) => e.isTrusted && (this.lastUserInput = Date.now()), true);
    }
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (this.publicId && changes[previewQaKey(this.publicId)]) void this.loadQa();
      if (changes.settings) void this.loadSettings();
      if (changes.exceptions) void this.loadFeedback();
    });
    chrome.runtime.onMessage.addListener((msg: RuntimeMsg) => {
      if (msg.type === 'panel:toggle') this.setOpen(!this.open);
    });
    this.restoreSession();
    void this.loadSettings().then(() => Promise.all([this.loadQa(), this.loadFeedback(), this.loadAiCache()]));
    setInterval(() => void this.auditStep(), 700);
  }

  private async loadSettings(): Promise<void> {
    const s = await loadSettings();
    if (isLang(s.language)) setLang(s.language);
    this.provider = `${s.llmProvider} · ${s.llmModel}`;
    this.hasKey = !!s.apiKey;
    this.autoAi = s.previewAutoAi;
    this.refresh();
  }

  private async loadQa(): Promise<void> {
    this.qa = this.publicId ? await loadPreviewQa(this.publicId) : null;
    this.refresh();
  }

  private setOpen(open: boolean): void {
    this.open = open;
    try {
      sessionStorage.setItem('gtmqa-preview-open', open ? '1' : '0');
    } catch {
      // storage unavailable – keep the state in memory
    }
    this.refresh();
  }

  private refresh(): void {
    this.cardSignature = '';
    this.schedule();
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    setTimeout(() => {
      this.scheduled = false;
      this.render();
    }, 200);
  }

  // --- reading Tag Assistant ----------------------------------------------------------------------

  private eventRows(): HTMLElement[] {
    return [...document.querySelectorAll<HTMLElement>('.message-list__row--indented')];
  }

  private selectedRow(): HTMLElement | null {
    return document.querySelector<HTMLElement>('.message-list__row--selected');
  }

  /** Key of the selected event, or null for the summary / page groups. */
  private selectedKey(): string | null {
    const row = this.selectedRow();
    return row?.classList.contains('message-list__row--indented') ? ownText(row) : null;
  }

  private tiles(): Tile[] {
    const out: Tile[] = [];
    for (const el of document.querySelectorAll<HTMLElement>('tags-tab .tags-tab__tag')) {
      const titleEl = el.querySelector<HTMLElement>('.gtm-debug-card__title');
      if (!titleEl) continue;
      const name = ownText(titleEl);
      const sub = [...el.children].filter((c) => c !== titleEl).map((c) => (c.textContent ?? '').replace(/\s+/g, ' ').trim()).find(Boolean) ?? '';
      const cut = sub.lastIndexOf(' - ');
      const sectionEl = el.closest<HTMLElement>('[class*="tags-tab__"][class*="-tags"]');
      const heading = (sectionEl?.firstElementChild?.textContent ?? '').trim();
      const section: Tile['section'] =
        sectionEl?.className.includes('fired-tags') && !/not/i.test(heading) ? 'fired' : /consent|einwilligung|zgod/i.test(heading) ? 'consent' : 'notFired';
      out.push({ el, titleEl, name, type: cut > 0 ? sub.slice(0, cut) : sub, status: cut > 0 ? sub.slice(cut + 3) : '', section });
    }
    return out;
  }

  private liveNotes(key: string, tiles: Tile[]): Note[] {
    const notes: Note[] = [];
    const fired = tiles.filter((x) => x.section === 'fired');
    for (const tile of tiles) {
      const base = { event: key, tag: tile.name, source: 'live' as const };
      if (/fail/i.test(tile.status)) notes.push({ ...base, kind: 'failed', severity: 'critical', text: t('failed') });
      const times = Number(tile.status.match(/(\d+)\s*(times|mal|razy)/i)?.[1] ?? 0);
      if (tile.section === 'fired' && times > 1) notes.push({ ...base, kind: 'firedTimes', severity: 'warning', text: t('firedTimes', { n: times }) });
      if (tile.section === 'consent') notes.push({ ...base, kind: 'consent', severity: 'info', text: t('consent') });
    }
    if (!fired.length && /purchase|kauf|bestell|checkout_complete|conversion|lead|generate_lead/i.test(eventName(key))) {
      notes.push({ event: key, tag: null, source: 'live', kind: 'noTags', severity: 'warning', text: t('noTagsConversion') });
    }
    return notes;
  }

  // --- the ongoing audit --------------------------------------------------------------------------

  /** One step: audit the next unchecked event while the user is idle, then restore their view. */
  private async auditStep(): Promise<void> {
    if (this.auditing || Date.now() - this.lastUserInput < IDLE_MS) return;
    const pending = this.eventRows().filter((r) => !this.audits.has(ownText(r)));
    if (!pending.length) return;

    const userRow = this.selectedRow();
    const userTab = this.activeTab();
    const started = Date.now();
    const interrupted = () => this.lastUserInput > started;
    try {
      // Oldest first, a few per step so the user gets control back quickly.
      for (const row of pending.reverse().slice(0, 4)) {
        if (interrupted()) return;
        const key = ownText(row);
        if (SKIP_EVENTS.test(eventName(key))) {
          this.audits.set(key, { key, live: [], ai: [], aiWanted: false });
          continue;
        }
        this.auditing = key;
        this.refresh();
        await this.readEvent(row, key);
      }
    } finally {
      this.auditing = null;
      if (!interrupted()) {
        // Back to what the user was looking at.
        if (userRow?.isConnected && this.selectedRow() !== userRow) userRow.click();
        await wait(250);
        if (userTab && userTab !== this.activeTab()) this.tab(userTab)?.click();
      }
      this.refresh();
      this.queueAi();
    }
  }

  private activeTab(): string | null {
    for (const [id, sel] of [['TAGS', 'tags-tab'], ['VARIABLES', 'variables-tab'], ['DATALAYER', 'data-data-layer-tab']] as const) {
      const el = document.querySelector<HTMLElement>(sel);
      if (el && el.offsetParent) return id;
    }
    return null;
  }

  private tab(id: string): HTMLElement | null {
    return document.querySelector<HTMLElement>(`.header__tab[data-ng-click="ctrl.selectTab(Tab.${id})"]`);
  }

  private async readEvent(row: HTMLElement, key: string): Promise<void> {
    row.click();
    await wait(150);
    if (this.activeTab() !== 'TAGS') this.tab('TAGS')?.click();
    await this.waitStable();
    const tiles = this.tiles();
    const fired = tiles.filter((x) => x.section === 'fired');
    const audit: Audit = {
      key,
      live: this.liveNotes(key, tiles),
      ai: [],
      aiWanted: fired.length > 0 && !NO_AI_EVENTS.test(eventName(key)),
    };
    if (audit.aiWanted) {
      audit.data = {
        event: key,
        fired: fired.map((x) => ({ name: x.name, type: x.type, status: x.status || undefined })),
        blockedByConsent: tiles.filter((x) => x.section === 'consent').map((x) => x.name),
        notFired: tiles.filter((x) => x.section === 'notFired' && !/paused|pausiert|wstrzym/i.test(x.status)).map((x) => x.name).slice(0, 40),
        ...(await this.readVariablesAndDataLayer()),
      };
      this.tab('TAGS')?.click();
      await wait(150);
      // The same setup was reviewed before (earlier page, earlier session): reuse that answer.
      audit.fp = fingerprint(audit.data);
      const cached = this.aiCache[audit.fp];
      if (cached) {
        audit.ai = cached.items.map((x) => ({ ...x, event: key, source: 'ai' as const, kind: 'ai' }));
        audit.aiDone = true;
      }
    }
    this.audits.set(key, audit);
    this.saveSession();
  }

  // --- persistence ----------------------------------------------------------------------------------

  private get sessionKey(): string {
    return `gtmqa-audits:${this.publicId ?? ''}`;
  }

  private get cacheKey(): string {
    return `previewAi:${this.publicId ?? ''}`;
  }

  /** Audits of this Tag Assistant tab survive a reload (sessionStorage is per tab). */
  private restoreSession(): void {
    try {
      const saved = JSON.parse(sessionStorage.getItem(this.sessionKey) ?? '[]') as Audit[];
      for (const a of saved) this.audits.set(a.key, a);
    } catch {
      // nothing stored or unreadable – start fresh
    }
  }

  private saveSession(): void {
    try {
      sessionStorage.setItem(this.sessionKey, JSON.stringify([...this.audits.values()]));
    } catch {
      // storage full or unavailable – the audit still works in memory
    }
  }

  private async loadAiCache(): Promise<void> {
    this.aiCache = ((await chrome.storage.local.get(this.cacheKey))[this.cacheKey] as Record<string, CachedAi> | undefined) ?? {};
  }

  private async storeAiCache(audits: Audit[]): Promise<void> {
    for (const a of audits) {
      if (a.fp) this.aiCache[a.fp] = { at: Date.now(), items: a.ai.map(({ severity, tag, text, fix }) => ({ severity, tag, text, fix })) };
    }
    const entries = Object.entries(this.aiCache).sort(([, x], [, y]) => y.at - x.at).slice(0, AI_CACHE_MAX);
    this.aiCache = Object.fromEntries(entries);
    await chrome.storage.local.set({ [this.cacheKey]: this.aiCache });
  }

  /** Waits until the Tags tab stops changing after selecting an event. */
  private async waitStable(): Promise<void> {
    let last = '';
    for (let i = 0; i < 10; i++) {
      await wait(150);
      const now = (document.querySelector('tags-tab')?.textContent ?? '').length.toString();
      if (now === last) return;
      last = now;
    }
  }

  private previousVariables: Record<string, string> = {};

  private async readVariablesAndDataLayer(): Promise<Pick<EventData, 'variables' | 'undefinedVariables' | 'dataLayer'>> {
    this.tab('VARIABLES')?.click();
    await wait(350);
    const rows = [...document.querySelectorAll('variables-tab tr')]
      .map((tr) => [...tr.querySelectorAll('td')].map((td) => (td.textContent ?? '').replace(/\s+/g, ' ').trim()))
      .filter((c) => c.length >= 4);
    const variables: Record<string, string> = {};
    const undefinedVariables: string[] = [];
    for (const [name, , returnType, raw] of rows) {
      if (returnType === 'undefined') {
        if (RELEVANT_VAR.test(name)) undefinedVariables.push(name);
        continue;
      }
      const value = PERSONAL.test(name) && raw && raw !== '""' ? '[masked]' : mask(raw);
      // Only what changed since the previous event or matters for conversions – keeps the payload small.
      if (RELEVANT_VAR.test(name) || this.previousVariables[name] !== value) variables[name] = value;
      this.previousVariables[name] = value;
    }
    this.tab('DATALAYER')?.click();
    await wait(300);
    const dataLayer = mask((document.querySelector('data-data-layer-tab')?.textContent ?? '').replace(/\s+/g, ' ').trim(), 2500);
    return { variables, undefinedVariables: undefinedVariables.slice(0, 40), dataLayer };
  }

  // --- AI -------------------------------------------------------------------------------------------

  private queueAi(): void {
    if (!this.autoAi || !this.hasKey || this.aiRequests >= AI_MAX_REQUESTS) return;
    clearTimeout(this.aiTimer);
    this.aiTimer = setTimeout(() => void this.runAiBatch(), AI_DEBOUNCE_MS);
  }

  private async runAiBatch(only?: string): Promise<void> {
    const batch = only
      ? [this.audits.get(only)].filter((a): a is Audit => !!a?.data)
      : [...this.audits.values()].filter((a) => a.aiWanted && !a.aiDone && a.data).slice(0, AI_BATCH);
    if (!batch.length) return;
    for (const a of batch) {
      a.aiDone = true;
      // A manual re-check replaces the previous answer.
      if (only) a.ai = [];
    }
    this.aiRunning = batch.length;
    this.aiError = '';
    if (!only) this.aiRequests++;
    this.refresh();
    const earlier = [...this.audits.values()].filter((a) => a.aiDone && !batch.includes(a) && a.data).map((a) => ({
      event: a.key,
      fired: a.data!.fired.map((x) => x.name),
    }));
    const tagNames = new Set(batch.flatMap((a) => [...a.data!.fired.map((x) => x.name), ...a.data!.blockedByConsent, ...a.data!.notFired]));
    const payload = {
      container: this.publicId,
      events: batch.map((a) => ({
        ...a.data,
        staticQa: Object.fromEntries(
          [...a.data!.fired.map((x) => x.name), ...a.data!.blockedByConsent]
            .filter((n) => this.qa?.tags[n])
            .map((n) => [n, this.qa!.tags[n].titles.map((s) => s.replace(/^\S+\s/, ''))]),
        ),
      })),
      earlierEvents: earlier.slice(-15),
    };
    try {
      const response: LlmResponse = await chrome.runtime.sendMessage({ type: 'llm:preview', input: JSON.stringify(payload) } satisfies RuntimeMsg);
      if (!response?.ok) throw new Error(response?.error ?? t('noSw'));
      const items = parseAi(response.text);
      const keys = new Set(batch.map((a) => a.key));
      for (const it of items) {
        const event = it.event && keys.has(it.event) ? it.event : batch[0].key;
        this.audits.get(event)!.ai.push({
          severity: it.severity,
          event,
          tag: it.tag && tagNames.has(it.tag) ? it.tag : null,
          text: it.title,
          fix: it.fix,
          source: 'ai',
          kind: 'ai',
        });
      }
      await this.storeAiCache(batch);
    } catch (err) {
      this.aiError = (err as Error).message;
    } finally {
      this.aiRunning = 0;
      this.saveSession();
      this.refresh();
      // More events waiting?
      if (!only && [...this.audits.values()].some((a) => a.aiWanted && !a.aiDone && a.data)) this.queueAi();
    }
  }

  // --- feedback -------------------------------------------------------------------------------------

  /** Live-check kinds marked "not correct" for a tag of this container (persist across sessions). */
  private async loadFeedback(): Promise<void> {
    const list = await loadExceptions();
    this.liveSuppressed = new Set(
      (list.feedback ?? [])
        .filter((f) => f.verdict === 'wrong' && f.source === 'preview-live' && f.publicId === this.publicId && f.kind)
        .map((f) => `${f.tag ?? ''}|${f.kind}`),
    );
    this.aiSuppressed = new Set(
      (list.feedback ?? [])
        .filter((f) => f.verdict === 'wrong' && f.source === 'preview-ai' && f.publicId === this.publicId)
        .map((f) => `${f.tag ?? ''}|${f.finding}`),
    );
    this.refresh();
  }

  /** Notes without the ones the user marked as not correct. */
  private shown(notes: Note[]): Note[] {
    return notes.filter(
      (n) =>
        this.verdicts.get(noteId(n)) !== 'wrong' &&
        !(n.source === 'live' && this.liveSuppressed.has(`${n.tag ?? ''}|${n.kind}`)) &&
        !(n.source === 'ai' && this.aiSuppressed.has(`${n.tag ?? ''}|${n.text}`)),
    );
  }

  private async saveFeedback(n: Note, verdict: Verdict, reason = '', teach = false): Promise<void> {
    this.verdicts.set(noteId(n), verdict);
    this.formFor = null;
    this.draft = '';
    this.refresh();
    await addFeedback({
      source: n.source === 'ai' ? 'preview-ai' : 'preview-live',
      verdict,
      kind: n.kind,
      publicId: this.publicId ?? undefined,
      event: eventName(n.event),
      tag: n.tag ?? undefined,
      finding: n.text,
      fix: n.fix,
      reason: reason || undefined,
    });
    if (teach && reason) {
      const params = { finding: n.text, tag: n.tag ? ` (tag "${n.tag}")` : '', event: eventName(n.event), reason };
      await addAiRule(verdict === 'wrong' ? t('aiRuleText', params) : t('aiRuleTextOk', params));
    }
  }

  private feedbackControls(n: Note): Node {
    const id = noteId(n);
    const verdict = this.verdicts.get(id);
    if (verdict === 'correct') return h('div', { class: 'fb done' }, t('fbConfirmed'));
    if (this.formFor?.id === id) {
      const wrong = this.formFor.verdict === 'wrong';
      const text = h('textarea', { rows: 2, placeholder: wrong ? t('fbPlaceholder') : t('fbPlaceholderOk') }) as HTMLTextAreaElement;
      text.value = this.draft;
      text.addEventListener('input', () => (this.draft = text.value));
      // A reason why something is NOT an error is the most useful lesson for the AI.
      const teach = h('input', { type: 'checkbox', checked: wrong }) as HTMLInputElement;
      setTimeout(() => text.focus(), 0);
      return h(
        'div',
        { class: `fb-form ${wrong ? 'wrong' : 'ok'}`, onClick: (e: Event) => e.stopPropagation() },
        h('label', { class: 'small strong' }, wrong ? t('fbWhy') : t('fbWhyOk')),
        text,
        h('label', { class: 'small inline' }, teach, ` ${t('fbTeach')}`),
        h(
          'div',
          { class: 'fb-actions' },
          h('button', { class: 'btn small', onClick: () => void this.saveFeedback(n, wrong ? 'wrong' : 'correct', text.value.trim(), teach.checked) }, t('fbSave')),
          h('button', { class: 'link', onClick: () => ((this.formFor = null), this.refresh()) }, t('fbCancel')),
        ),
      );
    }
    const open = (v: Verdict) => () => ((this.formFor = { id, verdict: v }), (this.draft = ''), this.refresh());
    return h(
      'div',
      { class: 'fb', onClick: (e: Event) => e.stopPropagation() },
      h('button', { class: 'fb-btn ok', onClick: open('correct') }, t('fbCorrect')),
      h('button', { class: 'fb-btn wrong', onClick: open('wrong') }, t('fbWrong')),
    );
  }

  // --- rendering ------------------------------------------------------------------------------------

  private render(): void {
    const key = this.selectedKey();
    const audit = key ? this.audits.get(key) : undefined;
    const notes = audit ? this.shown([...audit.live, ...audit.ai]) : [];
    for (const tile of this.tiles()) {
      this.decorateTile(tile, this.qa?.tags[tile.name], notes.filter((n) => n.tag === tile.name));
    }
    this.decorateEvents();
    this.renderCard();
  }

  private decorateTile(tile: Tile, qa: MarkCounts | undefined, notes: Note[]): void {
    const counts: Record<Severity, number> = { critical: qa?.critical ?? 0, warning: qa?.warning ?? 0, info: qa?.info ?? 0 };
    for (const n of notes) counts[n.severity]++;
    const worst = SEVERITIES.find((s) => counts[s] > 0);
    const signature = worst ? SEVERITIES.map((s) => counts[s]).join('/') + notes.map((n) => n.text).join('|') : '';
    if ((tile.el.getAttribute(TILE_ATTR) ?? '') === signature && (!worst || tile.titleEl.querySelector(`[${BADGE_ATTR}]`))) return;
    tile.el.setAttribute(TILE_ATTR, signature);
    tile.titleEl.querySelector(`[${BADGE_ATTR}]`)?.remove();
    if (!worst) {
      tile.el.style.removeProperty('box-shadow');
      tile.el.style.removeProperty('background-color');
      return;
    }
    tile.el.style.setProperty('box-shadow', `inset 5px 0 0 ${COLORS[worst]}`);
    tile.el.style.setProperty('background-color', TINTS[worst]);
    const box = document.createElement('span');
    box.setAttribute(BADGE_ATTR, signature);
    box.style.cssText = 'display:inline-flex;gap:4px;margin-left:8px;vertical-align:middle;float:right;';
    box.title = [
      qa?.titles.length ? t('tipQa') : '',
      ...(qa?.titles ?? []),
      notes.length ? t('tipEvent') : '',
      ...notes.map((n) => `${ICONS[n.severity]} ${n.text}${n.fix ? ` → ${n.fix}` : ''}`),
    ]
      .filter(Boolean)
      .join('\n');
    for (const s of SEVERITIES) if (counts[s]) box.append(dot(s, counts[s]));
    tile.titleEl.append(box);
  }

  private decorateEvents(): void {
    for (const row of this.eventRows()) {
      const key = ownText(row);
      const audit = this.audits.get(key);
      const notes = audit ? this.shown([...audit.live, ...audit.ai]) : [];
      const worst = worstOf(notes);
      const busy = this.auditing === key;
      const signature = busy ? 'busy' : worst ? `${worst}:${notes.filter((n) => n.severity === worst).length}` : audit ? 'ok' : '';
      const existing = row.querySelector<HTMLElement>(`[${BADGE_ATTR}]`);
      if ((existing?.getAttribute(BADGE_ATTR) ?? '') === signature) continue;
      existing?.remove();
      if (!signature) continue;
      const mark = worst ? dot(worst, notes.filter((n) => n.severity === worst).length) : document.createElement('span');
      if (!worst) {
        // Checked without findings: a small green tick; while checking: a hollow ring.
        mark.textContent = busy ? '◌' : '✓';
        mark.style.cssText = `display:inline-flex;justify-content:center;min-width:18px;font:700 12px/18px Roboto,Arial,sans-serif;color:${busy ? '#6e6eaa' : '#16a34a'};`;
      }
      mark.setAttribute(BADGE_ATTR, signature);
      // Between the number and the name: Tag Assistant uses the right edge of the row for its own hover controls.
      mark.style.margin = '0 8px 0 2px';
      mark.style.verticalAlign = 'middle';
      const title = row.querySelector('.message-list__title');
      if (title) row.insertBefore(mark, title);
      else row.prepend(mark);
    }
  }

  private renderCard(): void {
    // Keep the open feedback form (and what is typed in it) while the audit keeps running.
    if (this.formFor && this.root.querySelector('.fb-form')) return;
    const all = this.shown([...this.audits.values()].flatMap((a) => [...a.live, ...a.ai]));
    const key = this.selectedKey();
    const tiles = this.tiles();
    const signature = JSON.stringify([
      getLang(),
      this.open,
      this.qa?.createdAt,
      key,
      this.auditing,
      this.aiRunning,
      this.aiError,
      this.audits.size,
      all.map((n) => n.event + n.text),
      tiles.map((x) => x.name + x.section),
      [...this.verdicts],
      this.formFor,
    ]);
    if (signature === this.cardSignature) return;
    this.cardSignature = signature;
    if (!this.host.isConnected) document.body.append(this.host);
    const style = h('style', {}, CSS);
    const mark = () => {
      const m = h('span', { class: 'mark' });
      m.innerHTML = BRAND_MARK_SVG; // static SVG constant
      return m;
    };
    if (!this.open) {
      const pill = h('button', { class: 'pill', onClick: () => this.setOpen(true) }, mark(), 'QA');
      for (const s of SEVERITIES) {
        const n = all.filter((x) => x.severity === s).length;
        if (n) pill.append(dot(s, n));
      }
      this.root.replaceChildren(style, pill);
      return;
    }

    const qa = this.qa;
    const total = this.eventRows().length;
    const checked = this.eventRows().filter((r) => this.audits.has(ownText(r))).length;
    const aiDone = [...this.audits.values()].filter((a) => a.aiDone).length;
    const order = (n: Note) => SEVERITIES.indexOf(n.severity);
    // Newest events first (higher number), most severe first.
    const issues = all
      .filter((n) => n.severity !== 'info' || n.source === 'ai')
      .sort((a, b) => Number(b.event.match(/^\d+/)?.[0] ?? 0) - Number(a.event.match(/^\d+/)?.[0] ?? 0) || order(a) - order(b));
    const qaTags = tiles.filter((x) => qa?.tags[x.name] && (qa.tags[x.name].critical || qa.tags[x.name].warning));
    const audit = key ? this.audits.get(key) : undefined;

    const card = h(
      'div',
      { class: 'card' },
      h('div', { class: 'head' }, h('span', { class: 'brand' }, mark(), t('title')), h('button', { class: 'x', title: t('collapse'), onClick: () => this.setOpen(false) }, '–')),
      h(
        'div',
        { class: 'body' },
        h(
          'p',
          { class: 'small' },
          qa
            ? t('qaFrom', {
                scope: qa.scopeLabel,
                time: new Date(qa.createdAt).toLocaleString(getLang(), { dateStyle: 'short', timeStyle: 'short' }),
                c: qa.counts.critical,
                w: qa.counts.warning,
                i: qa.counts.info,
              })
            : t('qaNone', { id: this.publicId ?? 'GTM' }),
        ),
        h('p', { class: 'small status' }, t('auditStatus', { done: checked, total, ai: aiDone })),
        this.auditing ? h('p', { class: 'small busy' }, t('auditRunning', { name: this.auditing })) : null,
        this.aiRunning ? h('p', { class: 'small busy' }, t('aiRunning', { n: this.aiRunning, provider: this.provider })) : null,
        !this.hasKey ? h('p', { class: 'small muted' }, t('aiNoKey')) : !this.autoAi ? h('p', { class: 'small muted' }, t('aiOff')) : null,
        this.aiRequests >= AI_MAX_REQUESTS
          ? h(
              'p',
              { class: 'small muted' },
              t('aiLimit', { n: AI_MAX_REQUESTS }),
              ' ',
              h('button', { class: 'link', onClick: () => ((this.aiRequests = 0), this.queueAi(), this.refresh()) }, t('aiResume')),
            )
          : null,
        this.aiError ? h('p', { class: 'error' }, this.aiError) : null,

        h('div', { class: 'section' }, t('issuesTitle')),
        issues.length
          ? h(
              'ul',
              {},
              ...issues.slice(0, 25).map((n) => noteItem(n, () => this.select(n.event), this.feedbackControls(n))),
              issues.length > 25 ? h('li', { class: 'more' }, t('more', { n: issues.length - 25 })) : null,
            )
          : h('p', { class: 'small muted' }, t('noIssues')),

        qaTags.length
          ? h(
              'details',
              { class: 'qa' },
              h('summary', {}, t('qaTagsTitle'), ` (${qaTags.length})`),
              h(
                'ul',
                {},
                ...qaTags.map((x) =>
                  h(
                    'li',
                    { class: qa!.tags[x.name].critical ? 'critical' : 'warning' },
                    h('span', { class: 'sev' }),
                    h(
                      'div',
                      {},
                      h('strong', {}, x.name),
                      h('span', { class: 'state' }, ` · ${x.section === 'fired' ? t('fired') : x.section === 'consent' ? t('blocked') : t('notFired')}`),
                      ...qa!.tags[x.name].titles.filter((s) => !s.startsWith('🔵')).map((s) => h('div', { class: 'small' }, s.replace(/^\S+\s/, ''))),
                    ),
                  ),
                ),
              ),
            )
          : null,

        audit?.data && this.hasKey
          ? h(
              'div',
              { class: 'ai' },
              h('button', { class: 'btn', disabled: !!this.aiRunning, onClick: () => void this.runAiBatch(audit.key) }, t('aiButton')),
              h('p', { class: 'small muted' }, t('aiNote')),
            )
          : null,
        h('p', { class: 'legend' }, t('legend')),
      ),
    );
    this.root.replaceChildren(style, card);
  }

  private select(key: string): void {
    const row = this.eventRows().find((r) => ownText(r) === key);
    row?.click();
    this.lastUserInput = Date.now();
  }
}

function parseAi(text: string): { severity: Severity; event?: string; tag?: string; title: string; fix?: string }[] {
  const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  let data: { items?: unknown };
  try {
    data = JSON.parse(json) as { items?: unknown };
  } catch {
    throw new Error(t('aiBadAnswer'));
  }
  return (Array.isArray(data.items) ? (data.items as Record<string, unknown>[]) : [])
    .map((x) => ({
      severity: (SEVERITIES as string[]).includes(String(x.severity)) ? (x.severity as Severity) : 'info',
      event: typeof x.event === 'string' ? x.event : undefined,
      tag: typeof x.tag === 'string' ? x.tag : undefined,
      title: String(x.title ?? ''),
      fix: x.fix ? String(x.fix) : undefined,
    }))
    .filter((x) => x.title);
}

function dot(sev: Severity, n: number): HTMLElement {
  const d = document.createElement('span');
  d.textContent = String(n);
  d.style.cssText =
    'display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;padding:0 5px;box-sizing:border-box;' +
    `border-radius:9px;font:600 11px/1 Roboto,Arial,sans-serif;background:${COLORS[sev]};color:#fff;box-shadow:0 1px 2px rgba(0,0,0,.2);`;
  return d;
}

function noteItem(n: Note, onClick: () => void, extra?: Node): Node {
  return h(
    'li',
    { class: `${n.severity} clickable`, onClick },
    h('span', { class: 'sev' }),
    h(
      'div',
      {},
      h('div', { class: 'ev' }, n.event, n.source === 'ai' ? h('span', { class: 'tag-ai' }, 'AI') : null),
      n.tag ? h('strong', {}, n.tag, ': ') : null,
      n.text,
      n.fix ? h('div', { class: 'fix' }, '→ ', n.fix) : null,
      extra ?? null,
    ),
  );
}

const CSS = /* css */ `
:host { all: initial; }
* { box-sizing: border-box; }
.pill, .card { position: fixed; right: 18px; bottom: 18px; z-index: 2147483646; font: 13px/1.5 'GtmQaInter', Inter, system-ui, sans-serif; color: #111827; }
.pill {
  display: flex; align-items: center; gap: 8px; height: 42px; padding: 0 14px 0 10px; border-radius: 999px; cursor: pointer;
  border: 1px solid rgba(255,255,255,.18); background: linear-gradient(135deg, #3c0a6d 0%, #6e6eaa 100%); color: #fff;
  font-weight: 700; letter-spacing: .05em; box-shadow: 0 6px 18px rgba(52,2,84,.3);
}
.mark { display: inline-flex; width: 18px; height: 18px; }
.mark svg { width: 100%; height: 100%; }
.card {
  width: min(420px, calc(100vw - 36px)); max-height: calc(100vh - 100px); display: flex; flex-direction: column;
  background: #fff; border-radius: 14px; overflow: hidden; box-shadow: 0 16px 40px rgba(17,24,39,.22); border: 1px solid #e5e7eb;
}
.head { display: flex; align-items: center; justify-content: space-between; padding: 9px 12px; background: linear-gradient(135deg, #3c0a6d 0%, #6e6eaa 100%); color: #fff; }
.brand { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 12px; letter-spacing: .03em; }
.x { border: 0; background: transparent; color: #fff; font-size: 20px; line-height: 1; cursor: pointer; padding: 0 6px; }
.body { padding: 12px 14px; overflow: auto; }
p { margin: 4px 0; color: #374151; }
.small { font-size: 12px; }
.muted { color: #6b7280; }
.status { color: #340254; font-weight: 600; }
.busy { color: #6e6eaa; }
.section { margin: 12px 0 4px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: #6b7280; }
ul { list-style: none; margin: 4px 0; padding: 0; }
li { display: flex; gap: 8px; padding: 6px 4px; border-top: 1px solid #f3f4f6; border-radius: 6px; }
li:first-child { border-top: 0; }
li.clickable { cursor: pointer; }
li.clickable:hover { background: #faf7fd; }
li.more { color: #6b7280; font-size: 12px; }
.sev { flex: none; width: 10px; height: 10px; border-radius: 50%; margin-top: 5px; }
li.critical .sev { background: #ef4444; } li.warning .sev { background: #f59e0b; } li.info .sev { background: #3b82f6; }
.ev { font-size: 11px; color: #6b7280; display: flex; gap: 6px; align-items: center; }
.tag-ai { font-size: 10px; font-weight: 700; color: #6e3bb0; background: #f3eefa; border-radius: 4px; padding: 0 5px; }
.state { color: #6b7280; font-size: 12px; }
.fix { color: #15803d; font-size: 12px; margin-top: 2px; }
details.qa { margin-top: 10px; border-top: 1px solid #e5e7eb; padding-top: 8px; }
details.qa summary { cursor: pointer; font-size: 12px; font-weight: 600; color: #340254; }
.ai { margin-top: 10px; padding-top: 10px; border-top: 1px solid #e5e7eb; }
.btn { width: 100%; height: 34px; border: 0; border-radius: 10px; cursor: pointer; color: #fff; font-size: 13px; font-weight: 600; font-family: inherit;
  background: linear-gradient(135deg, #3c0a6d 0%, #6e6eaa 100%); }
.btn[disabled] { opacity: .65; cursor: progress; }
.link { border: 0; background: none; padding: 0; color: #6e3bb0; font-family: inherit; font-size: 12px; font-weight: 600; cursor: pointer; }
.error { color: #b91c1c; font-size: 12px; }
.legend { margin-top: 10px; font-size: 11px; color: #6b7280; }
.fb { display: flex; gap: 4px; margin-top: 4px; }
.fb.done { font-size: 11px; color: #15803d; font-weight: 600; }
.fb-btn { border: 1px solid #e5e7eb; background: #fff; border-radius: 6px; padding: 1px 7px; cursor: pointer; font-size: 12px; line-height: 18px; }
.fb-btn.ok:hover { background: #f0fdf4; border-color: #86efac; }
.fb-btn.wrong:hover { background: #fef2f2; border-color: #fca5a5; }
.strong { font-weight: 600; color: #340254; }
.fb-form.ok { border-color: #86efac; background: #f0fdf4; }
.fb-form { margin-top: 6px; padding: 8px; background: #faf7fd; border: 1px dashed #ae93d6; border-radius: 8px; cursor: default; }
.fb-form textarea { width: 100%; margin: 4px 0; font-size: 12px; line-height: 1.4; font-family: inherit; border: 1px solid #d1d5db; border-radius: 6px; padding: 6px; resize: vertical; }
.fb-form .inline { display: flex; gap: 6px; align-items: center; }
.fb-actions { display: flex; gap: 12px; align-items: center; margin-top: 6px; }
.btn.small { width: auto; height: 28px; padding: 0 12px; font-size: 12px; }
`;

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => new PreviewAuditor(), { once: true });
else new PreviewAuditor();
