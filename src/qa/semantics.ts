// Maps vendor-specific tag parameters to common semantic fields (value, currency, transaction id, …)
// and tags to the events they fire on, so tags of different vendors can be compared.
import type { GtmParameter, GtmTag, GtmTrigger, Snapshot } from '../shared/types';
import { Resolver, type Resolved } from './resolver';

export type SemanticField = 'value' | 'currency' | 'transaction_id' | 'items' | 'email' | 'phone' | 'server_url' | 'event_id';

/** Normalized parameter names (lowercase, alphanumerics only) per semantic field. */
const SYNONYMS: Record<SemanticField, string[]> = {
  value: ['value', 'conversionvalue', 'revenue', 'goalvalue', 'wert', 'totalvalue', 'ordervalue', 'transactiontotal', 'transactionrevenue'],
  currency: ['currency', 'currencycode', 'pcurrency', 'waehrung', 'wahrung', 'transactioncurrency'],
  transaction_id: ['transactionid', 'orderid', 'ordernumber', 'bestellnummer', 'nummer', 'transaction'],
  items: ['items', 'basket', 'products'],
  email: ['email', 'emails', 'emailaddress', 'sha256emailaddress', 'em'],
  phone: ['phone', 'phonenumber', 'phonenumbers', 'phone_number'],
  server_url: ['servercontainerurl', 'transporturl', 'serverurl'],
  event_id: ['eventid', 'dedupid', 'deduplicationid'],
};

const FIELD_BY_NAME = new Map<string, SemanticField>(
  Object.entries(SYNONYMS).flatMap(([field, names]) => names.map((n) => [n, field as SemanticField] as const)),
);

export const normalizeName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

export function semanticField(paramName: string): SemanticField | undefined {
  return FIELD_BY_NAME.get(normalizeName(paramName));
}

/** One concrete parameter leaf, e.g. eventSettingsTable[value] = {{DLV - value}}. */
export interface ParamLeaf {
  name: string;
  value: string;
  path: string;
}

const ROW_NAME_KEYS = ['parameter', 'key', 'name', 'custom_name', 'fieldName'];
const ROW_VALUE_KEYS = ['parameterValue', 'value', 'custom_value'];

/** Flattens parameters; "rows" ({parameter: x, parameterValue: y}) become a leaf named x. */
export function paramLeaves(params: GtmParameter[], prefix = ''): ParamLeaf[] {
  const out: ParamLeaf[] = [];
  for (const p of params) {
    const here = p.key ? (prefix ? `${prefix}.${p.key}` : p.key) : prefix;
    if (p.map) {
      const nameEntry = p.map.find((x) => x.key && ROW_NAME_KEYS.includes(x.key) && x.value);
      const valueEntry = p.map.find((x) => x.key && ROW_VALUE_KEYS.includes(x.key) && x !== nameEntry);
      if (nameEntry?.value && valueEntry) out.push({ name: nameEntry.value, value: valueEntry.value ?? '', path: `${here}[${nameEntry.value}]` });
      else out.push(...paramLeaves(p.map, here));
    } else if (p.list) {
      out.push(...paramLeaves(p.list, here));
    } else if (p.key) {
      out.push({ name: p.key, value: p.value ?? '', path: here });
    }
  }
  return out;
}

export interface FieldUse {
  tag: GtmTag;
  field: SemanticField;
  path: string;
  raw: string;
  resolved: Resolved;
}

export function fieldUses(tag: GtmTag, resolver: Resolver): FieldUse[] {
  const out: FieldUse[] = [];
  for (const leaf of paramLeaves(tag.parameters)) {
    const field = semanticField(leaf.name);
    if (!field || leaf.value === '') continue;
    out.push({ tag, field, path: leaf.path, raw: leaf.value, resolved: resolver.resolveValue(leaf.value) });
  }
  return out;
}

// --- events ------------------------------------------------------------------

const PAGE_TYPES = new Set(['pageview', 'domReady', 'windowLoaded', 'init', 'consentInit']);

/**
 * Event identity of a trigger. Custom events are identified by dataLayer event name (so different
 * triggers listening to "purchase" count as the same event); page triggers by type + conditions.
 */
export function triggerEvents(t: GtmTrigger): string[] {
  // Extra conditions distinguish e.g. one generic "pageview" event on the purchase vs the basket page.
  const conds = t.filters.filter.map((c) => `${c.left} ${c.negate ? 'NOT ' : ''}${c.op} ${c.right}`).sort();
  const withConds = (name: string) => (conds.length ? `${name} [${conds.join(' & ')}]` : name);
  if (t.type === 'customEvent') {
    const cond = t.filters.customEventFilter.find((c) => c.left === '{{_event}}' && !c.negate);
    if (cond?.op === 'equals') return [withConds(cond.right)];
    if (cond?.op === 'matchRegex') {
      const simple = cond.right.replace(/^\^\(?|\)?\$$/g, '');
      return /^[\w.\-]+(\|[\w.\-]+)*$/.test(simple) ? simple.split('|').map(withConds) : [withConds(`regex:${cond.right}`)];
    }
    if (cond) return [withConds(`${cond.op}:${cond.right}`)];
  }
  if (PAGE_TYPES.has(t.type)) return [conds.length ? `${t.type} [${conds.join(' & ')}]` : t.type === 'pageview' ? 'All Pages' : t.type];
  return [`${t.type}: ${t.name}`];
}

export function tagEvents(tag: GtmTag, snap: Snapshot): string[] {
  const events = new Set<string>();
  for (const id of tag.firingTriggerIds) {
    const trigger = snap.triggers[id];
    for (const e of trigger ? triggerEvents(trigger) : [`#${id}`]) events.add(e);
  }
  return [...events];
}

/** Trigger fires on every page load without conditions. */
export function isAllPages(t: GtmTrigger | undefined): boolean {
  return !!t && PAGE_TYPES.has(t.type) && t.type !== 'consentInit' && t.filters.filter.length === 0;
}
