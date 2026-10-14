import { defineMessages } from '../i18n';

// Agency exceptions ("this is not an error"), stored locally and shareable via JSON export/import.
// Import only ADDS entries that are missing – it never overwrites or deletes – so lists from several
// people can be merged. The file format is meant to map 1:1 onto a shared database later.

/** Hides a QA finding (or some of its entities) in later runs. */
export interface Suppression {
  id: string;
  rule: string;
  /** Finding.key – language-independent identity within the rule (e.g. event + field). */
  findingKey: string;
  /** "kind:name" of the entities the exception covers (names, so it also works across containers). */
  entities: string[];
  /** Container the exception applies to; undefined = all containers. */
  containerId?: string;
  publicId?: string;
  /** Original finding title, for display. */
  title: string;
  reason?: string;
  createdAt: number;
}

/** A rule for the AI summary, appended to its instructions. */
export interface AiRule {
  id: string;
  text: string;
  createdAt: number;
}

export interface ExceptionList {
  version: 1;
  suppressions: Suppression[];
  aiRules: AiRule[];
}

const KEY = 'exceptions';

/** Agency rules that used to be hard-coded in the prompt – now editable. */
const t = defineMessages({
  en: {
    rule1: 'Additional consent settings in tags are the client’s decision – they are neither an error nor a risk; at most, neutrally note their state.',
    rule2: 'FAST is an internal tool (fingerprint, no customer data) – it needs no consent; additional consent on a FAST tag is unnecessary.',
    rule3: 'FAST Script is sometimes embedded in the page code while GTM only contains FAST Conversion – a missing or paused FAST Script tag in GTM is not an error.',
    rule4: 'Base scripts, libraries and pixels may be embedded in the page code – do not infer missing scripts or dependencies between tags unless the data shows them explicitly.',
    invalidJson: 'The file is not valid JSON.',
    notExceptions: 'This is not a GTM QA Checker exceptions file.',
  },
  de: {
    rule1: 'Zusätzliche Einwilligungseinstellungen in Tags sind Entscheidung des Kunden – weder Fehler noch Risiko; höchstens neutral den Stand vermerken.',
    rule2: 'FAST ist ein internes Tool (Fingerprint, keine Kundendaten) – es benötigt keine Einwilligung; eine zusätzliche Einwilligung im FAST-Tag ist überflüssig.',
    rule3: 'FAST Script ist teils direkt im Seitencode eingebunden, während GTM nur FAST Conversion enthält – ein fehlender oder pausierter FAST-Script-Tag in GTM ist kein Fehler.',
    rule4: 'Basisskripte, Bibliotheken und Pixel können im Seitencode eingebunden sein – keine fehlenden Skripte oder Abhängigkeiten zwischen Tags ableiten, wenn die Daten sie nicht eindeutig zeigen.',
    invalidJson: 'Die Datei ist kein gültiges JSON.',
    notExceptions: 'Das ist keine Ausnahmedatei von GTM QA Checker.',
  },
  pl: {
    rule1: 'Dodatkowe zgody w ustawieniach tagów to decyzja klienta – nie są błędem ani ryzykiem; najwyżej odnotuj neutralnie ich stan.',
    rule2: 'FAST to wewnętrzne narzędzie (fingerprint, bez danych klienta) – nie wymaga zgody; dodatkowa zgoda w tagu FAST jest zbędna.',
    rule3: 'FAST Script bywa wbudowany w kod strony, a w GTM jest tylko FAST Conversion – brak lub wstrzymanie FAST Script w GTM nie jest błędem.',
    rule4: 'Skrypty bazowe, biblioteki i piksele mogą być osadzone w kodzie strony – nie wnioskuj o brakujących skryptach ani zależnościach między tagami, jeśli dane wprost tego nie pokazują.',
    invalidJson: 'Plik nie jest poprawnym JSON-em.',
    notExceptions: 'To nie jest plik z wyjątkami GTM QA Checker.',
  },
});

/** Seeded in the language active at first run; afterwards they are ordinary, editable entries. */
const defaultAiRules = () => [t('rule1'), t('rule2'), t('rule3'), t('rule4')];

export function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function loadExceptions(): Promise<ExceptionList> {
  const stored = (await chrome.storage.local.get(KEY))[KEY] as ExceptionList | undefined;
  if (stored) return stored;
  // First run: seed the editable defaults.
  const seeded: ExceptionList = {
    version: 1,
    suppressions: [],
    aiRules: defaultAiRules().map((text, i) => ({ id: `default-${i + 1}`, text, createdAt: 0 })),
  };
  await saveExceptions(seeded);
  return seeded;
}

export async function saveExceptions(list: ExceptionList): Promise<void> {
  await chrome.storage.local.set({ [KEY]: list });
}

export async function addSuppression(s: Omit<Suppression, 'id' | 'createdAt'>): Promise<void> {
  const list = await loadExceptions();
  list.suppressions.push({ ...s, id: newId(), createdAt: Date.now() });
  await saveExceptions(list);
}

export async function addAiRule(text: string): Promise<boolean> {
  const list = await loadExceptions();
  const clean = text.trim();
  if (!clean || list.aiRules.some((r) => normalize(r.text) === normalize(clean))) return false;
  list.aiRules.push({ id: newId(), text: clean, createdAt: Date.now() });
  await saveExceptions(list);
  return true;
}

export async function removeException(kind: 'suppression' | 'aiRule', id: string): Promise<void> {
  const list = await loadExceptions();
  if (kind === 'suppression') list.suppressions = list.suppressions.filter((s) => s.id !== id);
  else list.aiRules = list.aiRules.filter((r) => r.id !== id);
  await saveExceptions(list);
}

export function exportJson(list: ExceptionList): string {
  return JSON.stringify({ ...list, exportedAt: new Date().toISOString() }, null, 2);
}

/** Adds entries from an exported file that are not present yet (by id and by content). */
export async function importJson(text: string): Promise<{ added: number; skipped: number }> {
  let incoming: Partial<ExceptionList>;
  try {
    incoming = JSON.parse(text);
  } catch {
    throw new Error(t('invalidJson'));
  }
  if (!Array.isArray(incoming.suppressions) && !Array.isArray(incoming.aiRules)) {
    throw new Error(t('notExceptions'));
  }
  const list = await loadExceptions();
  let added = 0;
  let skipped = 0;

  const suppressionKey = (s: Suppression) => [s.rule, s.findingKey, s.containerId ?? '*', [...s.entities].sort().join('|')].join('#');
  const haveIds = new Set(list.suppressions.map((s) => s.id));
  const haveKeys = new Set(list.suppressions.map(suppressionKey));
  for (const s of incoming.suppressions ?? []) {
    if (!s?.rule || !Array.isArray(s.entities) || haveIds.has(s.id) || haveKeys.has(suppressionKey(s))) {
      skipped++;
      continue;
    }
    list.suppressions.push(s);
    haveIds.add(s.id);
    haveKeys.add(suppressionKey(s));
    added++;
  }

  const ruleTexts = new Set(list.aiRules.map((r) => normalize(r.text)));
  const ruleIds = new Set(list.aiRules.map((r) => r.id));
  for (const r of incoming.aiRules ?? []) {
    if (!r?.text || ruleIds.has(r.id) || ruleTexts.has(normalize(r.text))) {
      skipped++;
      continue;
    }
    list.aiRules.push(r);
    ruleIds.add(r.id);
    ruleTexts.add(normalize(r.text));
    added++;
  }

  await saveExceptions(list);
  return { added, skipped };
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}
