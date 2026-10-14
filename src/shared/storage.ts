// Extension settings persisted in chrome.storage.local.
import type { Lang } from '../i18n';

export type LlmProvider = 'openai' | 'anthropic' | 'gemini';

export interface Settings {
  /** UI, report and AI summary language. */
  language: Lang;
  llmProvider: LlmProvider;
  llmModel: string;
  apiKey: string;
  /** Optional extra naming rule for tags/triggers/variables, as a RegExp source. */
  namingPattern: string;
  /** Expected server_container_url for server-side tagging; empty = only check consistency. */
  expectedServerContainerUrl: string;
  /** Enforce the agency taxonomy ([SST] Platform - Event, ce/pv triggers, DLV/CJS/... variables). */
  namingTaxonomy: boolean;
  /** Tags exempt from consent checks, matched against template or tag name (internal tools, e.g. FAST). */
  consentExempt: string[];
  /** Keywords used to classify value variables / dataLayer keys. */
  financialKeywords: {
    gross: string[];
    net: string[];
    neutral: string[];
  };
}

export const DEFAULT_MODELS: Record<LlmProvider, string> = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-opus-5-5',
  gemini: 'gemini-2.5-flash',
};

export const DEFAULT_SETTINGS: Settings = {
  language: 'en',
  llmProvider: 'anthropic',
  llmModel: DEFAULT_MODELS.anthropic,
  apiKey: '',
  // Empty = naming check disabled until the agency sets its convention.
  namingPattern: '',
  expectedServerContainerUrl: '',
  namingTaxonomy: true,
  consentExempt: ['FAST'],
  financialKeywords: {
    gross: ['brutto', 'gross', 'total', 'incl', 'with_tax'],
    net: ['netto', 'net', 'subtotal', 'excl', 'without_tax'],
    neutral: ['value', 'revenue', 'price', 'tax', 'shipping'],
  },
};

const KEY = 'settings';

export async function loadSettings(): Promise<Settings> {
  const stored = (await chrome.storage.local.get(KEY))[KEY] as Partial<Settings> | undefined;
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    financialKeywords: { ...DEFAULT_SETTINGS.financialKeywords, ...stored?.financialKeywords },
  };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await loadSettings()), ...patch };
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}
