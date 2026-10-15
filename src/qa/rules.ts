// QA rules. Each rule inspects one snapshot and returns findings; nothing here does I/O.
import type { Settings } from '../shared/storage';
import type { EntityKind, GtmEntity, GtmTag, GtmTrigger, GtmVariable, Snapshot } from '../shared/types';
import { t } from './i18n';
import { describeSource, Resolver, sourceKey, sourceText, type Source } from './resolver';
import { namingTaxonomy } from './taxonomy';
import { isAllPages, normalizeName, paramLeaves, type FieldUse, type SemanticField } from './semantics';

export type Severity = 'critical' | 'warning' | 'info';

export interface EntityRef {
  kind: EntityKind;
  id: string;
  name: string;
}

export interface Finding {
  rule: string;
  /**
   * Stable, language-independent identity of the finding within its rule (e.g. "purchase|value" for a
   * source-consistency finding). Agency exceptions match on rule + key, so they survive language switches.
   */
  key: string;
  severity: Severity;
  title: string;
  message: string;
  entities: EntityRef[];
  details: string[];
  /** Concrete fixes per element (e.g. the name it should have), shown as a "How to fix" list. */
  fixes?: Fix[];
}

export interface Fix {
  entity: EntityRef;
  /** What the value should be (e.g. the correct name). */
  suggestion: string;
  reason: string;
}

export interface LintContext {
  snap: Snapshot;
  settings: Settings;
  resolver: Resolver;
  tags: GtmTag[];
  /** Tags that can fire (not paused). */
  active: GtmTag[];
  triggers: GtmTrigger[];
  variables: GtmVariable[];
  uses: FieldUse[];
  /** tag id -> events it fires on. */
  events: Map<string, string[]>;
  /** variable name -> entities referencing it. */
  references: Map<string, Set<string>>;
  /** cvt_… type -> custom template name. */
  templates: Map<string, string>;
  /** Ids of tags that send data to a server container (filled by the SST analysis before rules run). */
  sstRouted: Set<string>;
}

/** Human type label: template name for custom templates, raw type otherwise. */
export function typeName(ctx: LintContext, type: string): string {
  return ctx.templates.get(type) ?? type;
}

export type Rule = (ctx: LintContext) => Finding[];

const ref = (e: GtmEntity): EntityRef => ({ kind: e.kind, id: e.id, name: e.name });
const NUMERIC = /^-?\d+(\.\d+)?$/;
const CURRENCY = /^[A-Z]{3}$/;

const FIELD_LABEL_KEY = {
  value: 'fieldValue',
  currency: 'fieldCurrency',
  transaction_id: 'fieldTransactionId',
  items: 'fieldItems',
  email: 'fieldEmail',
  phone: 'fieldPhone',
  server_url: 'fieldServerUrl',
  event_id: 'fieldEventId',
} as const satisfies Record<SemanticField, string>;

/** Human label of a semantic field in the active language. */
const fieldLabel = (field: SemanticField) => t(FIELD_LABEL_KEY[field]);

/** "  (via A → B)" suffix for values reached through variables. */
const viaSuffix = (via: string[]) => (via.length ? `  (${t('via', { chain: via.join(' → ') })})` : '');

const GA4_EVENTS = [
  'add_payment_info', 'add_shipping_info', 'add_to_cart', 'add_to_wishlist', 'begin_checkout', 'generate_lead',
  'login', 'purchase', 'refund', 'remove_from_cart', 'search', 'select_content', 'select_item', 'select_promotion',
  'share', 'sign_up', 'view_cart', 'view_item', 'view_item_list', 'view_promotion', 'page_view', 'view_search_results',
];

/** Event / trigger names that indicate a purchase (shared with the report). */
export const PURCHASE_EVENT = /purchase|transaction|order|kauf|bestell|zakup|checkout_?complete|thank|danke/i;

// --- 1. same field, different sources ---------------------------------------------

export const sourceConsistency: Rule = (ctx) => {
  const findings: Finding[] = [];
  const kw = ctx.settings.financialKeywords;
  const groups = new Map<string, FieldUse[]>();
  for (const use of ctx.uses) {
    if (use.tag.paused || !['value', 'currency', 'transaction_id', 'items', 'event_id'].includes(use.field)) continue;
    for (const event of ctx.events.get(use.tag.id) ?? []) {
      const key = `${event}\u0000${use.field}`;
      groups.set(key, [...(groups.get(key) ?? []), use]);
    }
  }

  for (const [key, uses] of groups) {
    const [event, field] = key.split('\u0000') as [string, SemanticField];
    const bySource = new Map<string, { source: Source; uses: FieldUse[] }>();
    for (const u of uses) {
      const k = sourceKey(u.resolved.source);
      const entry = bySource.get(k) ?? { source: u.resolved.source, uses: [] };
      entry.uses.push(u);
      bySource.set(k, entry);
    }
    if (bySource.size < 2) continue;

    // Language-independent text, so the gross/net detection does not depend on the UI language.
    const texts = [...bySource.values()].map((g) => `${sourceText(g.source)} ${g.uses.map((u) => u.raw).join(' ')}`.toLowerCase());
    const has = (words: string[]) => texts.some((t) => words.some((w) => t.includes(w)));
    const grossNet = field === 'value' && has(kw.gross) && has(kw.net);
    const currencyClash =
      field === 'currency' && [...bySource.values()].filter((g) => g.source.kind === 'constant' || g.source.kind === 'text').length > 1;

    findings.push({
      rule: 'source-consistency',
      key: `${event}|${field}`,
      // Item arrays are vendor-formatted (GA4 items vs Criteo basket), so differences are expected.
      severity: grossNet || currencyClash ? 'critical' : field === 'items' ? 'info' : 'warning',
      title: t('scTitle', { field: fieldLabel(field), event }),
      message: t(grossNet ? 'scGrossNet' : currencyClash ? 'scCurrency' : 'scDefault'),
      entities: unique(uses.map((u) => ref(u.tag))),
      details: [...bySource.values()].flatMap((g) => [
        `▸ ${describeSource(g.source)}`,
        ...g.uses.map((u) => `    ${u.tag.name} [${u.tag.type}] ${u.path} = ${u.raw}${viaSuffix(u.resolved.via)}`),
      ]),
    });
  }
  return findings;
};

// --- 2. duplicate variables ----------------------------------------------------------

export const duplicateVariables: Rule = (ctx) => {
  const groups = new Map<string, GtmVariable[]>();
  for (const v of ctx.variables) {
    const resolved = ctx.resolver.resolveName(v.name).source;
    const signature =
      resolved.kind === 'other' || resolved.kind === 'lookup'
        ? `${v.type}|${paramLeaves(v.parameters).map((l) => `${l.path}=${l.value}`).sort().join('|')}`
        : `${v.type}|${sourceKey(resolved)}`;
    groups.set(signature, [...(groups.get(signature) ?? []), v]);
  }
  return [...groups]
    .filter(([, g]) => g.length > 1)
    .map(([signature, g]) => ({
      rule: 'duplicate-variables',
      key: signature,
      severity: 'warning' as const,
      title: t('dupVarsTitle', {
        count: g.length,
        source: g[0].type.startsWith('cvt_') ? t('template', { name: typeName(ctx, g[0].type) }) : describeSource(ctx.resolver.resolveName(g[0].name).source),
      }),
      message: t('dupVarsMessage'),
      entities: g.map(ref),
      details: g.map((v) => t('dupVarsDetail', { name: v.name, users: usersOf(ctx, v.name).join(', ') || t('nowhere') })),
    }));
};

function usersOf(ctx: LintContext, variableName: string): string[] {
  return [...(ctx.references.get(variableName) ?? [])];
}

/** variable name -> names of entities referencing it (tags, triggers, other variables). */
export function buildReferenceIndex(tags: GtmTag[], triggers: GtmTrigger[], variables: GtmVariable[]): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  const add = (value: string, owner: string) => {
    for (const name of Resolver.references(value)) index.set(name, (index.get(name) ?? new Set()).add(owner));
  };
  for (const e of [...tags, ...variables]) for (const l of paramLeaves(e.parameters)) add(l.value, e.name);
  for (const t of triggers) for (const c of Object.values(t.filters).flat()) (add(c.left, t.name), add(c.right, t.name));
  return index;
}

// --- 3. duplicate tags / same conversion sent twice ----------------------------------

export const duplicateTags: Rule = (ctx) => {
  const findings: Finding[] = [];

  const exact = new Map<string, GtmTag[]>();
  for (const tag of ctx.active) {
    const sig = [tag.type, [...tag.firingTriggerIds].sort().join(','), paramLeaves(tag.parameters).map((l) => `${l.path}=${l.value}`).sort().join('|')].join('#');
    exact.set(sig, [...(exact.get(sig) ?? []), tag]);
  }
  for (const g of exact.values()) {
    if (g.length < 2) continue;
    findings.push({
      rule: 'duplicate-tags',
      key: g.map((x) => x.id).sort().join(','),
      severity: 'critical',
      title: t('dupTagsTitle', { count: g.length }),
      message: t('dupTagsMessage'),
      entities: g.map(ref),
      details: g.map((x) => `${x.name} [${x.type}]`),
    });
  }
  const reported = new Set([...exact.values()].filter((g) => g.length > 1).flat().map((x) => x.id));

  // Same destination (conversion / measurement id + event) configured in several tags.
  // key: language-independent grouping key; label: shown in the title.
  const destination = (tag: GtmTag): { key: string; label: string } | null => {
    const p = (k: string) => paramLeaves(tag.parameters).find((l) => l.path === k)?.value;
    const r = (v?: string) => (v === undefined ? '' : sourceKey(ctx.resolver.resolveValue(v).source));
    if (tag.type === 'awct') {
      const [id, label] = [r(p('conversionId')), r(p('conversionLabel'))];
      return { key: `awct|${id}|${label}`, label: t('destAdsConversion', { id, label }) };
    }
    if (tag.type === 'gaawe') {
      const [id, event] = [r(p('measurementIdOverride')), r(p('eventName'))];
      return { key: `gaawe|${id}|${event}`, label: t('destGa4Event', { id, event }) };
    }
    if (tag.type === 'googtag') return { key: `googtag|${r(p('tagId'))}`, label: `Google tag ${r(p('tagId'))}` };
    if (tag.type === 'sp') return { key: `sp|${r(p('conversionId'))}`, label: `Google Ads remarketing ${r(p('conversionId'))}` };
    return null;
  };
  const byDest = new Map<string, { label: string; tags: GtmTag[] }>();
  for (const tag of ctx.active) {
    if (reported.has(tag.id)) continue;
    const d = destination(tag);
    if (d) byDest.set(d.key, { label: d.label, tags: [...(byDest.get(d.key)?.tags ?? []), tag] });
  }
  for (const [destKey, { label: dest, tags: g }] of byDest) {
    if (g.length < 2) continue;
    // Only a problem when the tags can fire for the same event.
    const shared = intersectAll(g.map((x) => ctx.events.get(x.id) ?? []));
    if (!shared.length && !g.every((x) => x.type === 'googtag')) continue;
    findings.push({
      rule: 'duplicate-destination',
      key: destKey,
      severity: g[0].type === 'googtag' ? 'warning' : 'critical',
      title: t('dupDestTitle', { count: g.length, dest: dest.replace(/(value|dataLayer|builtin):/g, '') }),
      message: shared.length ? t('dupDestShared', { events: shared.join(', ') }) : t('dupDestGoogleTag'),
      entities: g.map(ref),
      details: g.map((x) => t('dupDestDetail', { name: x.name, events: (ctx.events.get(x.id) ?? []).join(', ') || t('none') })),
    });
  }
  return findings;
};

// --- 5. data types and broken references ------------------------------------------------

export const dataTypes: Rule = (ctx) => {
  const findings: Finding[] = [];
  for (const u of ctx.uses) {
    if (u.tag.paused) continue;
    const s = u.resolved.source;
    const where = `${u.tag.name}: ${u.path} = ${u.raw}`;
    if (u.field === 'value') {
      if ((s.kind === 'constant' || s.kind === 'text') && !NUMERIC.test(s.value.trim())) {
        findings.push(typeFinding('critical', u, 'not-numeric', t('valueNotNumberTitle'), t('valueNotNumberMessage', { value: s.value }), where));
      } else if (s.kind === 'mixed') {
        findings.push(typeFinding('critical', u, 'mixed', t('valueMixedTitle'), t('valueMixedMessage'), where));
      } else if (s.kind === 'customJs' && /\.toFixed\(/.test(s.code) && !/parseFloat|Number\(|\*\s*1\b|\+\s*\(/.test(s.code)) {
        findings.push(typeFinding('warning', u, 'to-fixed', t('toFixedTitle'), t('toFixedMessage'), where));
      } else if (s.kind === 'dataLayer' && s.defaultValue !== undefined && !NUMERIC.test(s.defaultValue)) {
        findings.push(typeFinding('warning', u, 'default-value', t('defaultValueTitle'), t('defaultValueMessage', { value: s.defaultValue }), where));
      }
    }
    if (u.field === 'currency' && (s.kind === 'constant' || s.kind === 'text') && !CURRENCY.test(s.value.trim())) {
      findings.push(typeFinding('warning', u, 'currency-code', t('currencyCodeTitle'), t('currencyCodeMessage', { value: s.value }), where));
    }
  }

  // GA4 events with value but without currency.
  for (const tag of ctx.active.filter((x) => x.type === 'gaawe')) {
    const fields = new Set(ctx.uses.filter((u) => u.tag === tag).map((u) => u.field));
    if (fields.has('value') && !fields.has('currency')) {
      findings.push({ rule: 'ga4-currency', key: tag.id, severity: 'warning', title: t('ga4CurrencyTitle'), message: t('ga4CurrencyMessage'), entities: [ref(tag)], details: [tag.name] });
    }
  }

  // References to variables that do not exist.
  const missing = new Map<string, Set<string>>();
  const check = (owner: GtmEntity, value: string) => {
    for (const name of Resolver.references(value)) {
      if (!ctx.resolver.isKnownReference(name)) missing.set(name, (missing.get(name) ?? new Set()).add(`${owner.name}`));
    }
  };
  for (const e of [...ctx.tags, ...ctx.variables]) for (const l of paramLeaves(e.parameters)) check(e, l.value);
  for (const tr of ctx.triggers) for (const c of Object.values(tr.filters).flat()) (check(tr, c.left), check(tr, c.right));
  for (const [name, owners] of missing) {
    findings.push({
      rule: 'missing-reference',
      key: name,
      severity: 'critical',
      title: t('missingRefTitle', { ref: `{{${name}}}` }),
      message: t('missingRefMessage'),
      entities: [...ctx.tags, ...ctx.variables, ...ctx.triggers].filter((e) => owners.has(e.name)).map(ref),
      details: [...owners],
    });
  }
  return findings;
};

/** kind: language-independent problem id, part of the finding key. */
function typeFinding(severity: Severity, u: FieldUse, kind: string, title: string, message: string, where: string): Finding {
  return {
    rule: 'data-type',
    key: `${u.tag.id}|${u.path}|${kind}`,
    severity,
    title,
    message,
    entities: [ref(u.tag)],
    details: [where, ...(u.resolved.via.length ? [t('via', { chain: u.resolved.via.join(' → ') })] : [])],
  };
}

// --- 6. conversion setup ---------------------------------------------------------------

export const conversions: Rule = (ctx) => {
  const findings: Finding[] = [];
  for (const tag of ctx.active) {
    const triggers = tag.firingTriggerIds.map((id) => ctx.snap.triggers[id]);
    if (tag.type === 'awct' && triggers.some((x) => isAllPages(x))) {
      findings.push({
        rule: 'conversion-all-pages',
        key: tag.id,
        severity: 'warning',
        title: t('allPagesTitle'),
        message: t('allPagesMessage'),
        entities: [ref(tag)],
        details: [`${tag.name} – ${triggers.filter(isAllPages).map((x) => x!.name).join(', ')}`],
      });
    }
    const events = ctx.events.get(tag.id) ?? [];
    const isPurchase = events.some((e) => PURCHASE_EVENT.test(e)) || triggers.some((x) => x && PURCHASE_EVENT.test(x.name));
    const fields = new Set(ctx.uses.filter((u) => u.tag === tag).map((u) => u.field));
    // Microsoft UET has no transaction id field; GA4 may take it from the dataLayer ecommerce object.
    const ecommerceObject = tag.type === 'gaawe' && paramLeaves(tag.parameters).some((l) => l.name === 'sendEcommerceData' && l.value === 'true');
    if (isPurchase && ['awct', 'gaawe'].includes(tag.type) && !ecommerceObject && fields.has('value') && !fields.has('transaction_id')) {
      findings.push({
        rule: 'conversion-no-transaction-id',
        key: tag.id,
        severity: 'warning',
        title: t('noTransactionIdTitle'),
        message: t('noTransactionIdMessage'),
        entities: [ref(tag)],
        details: [`${tag.name} – ${events.join(', ')}`],
      });
    }
  }
  return findings;
};

// --- 6b. personal data in GA4 ----------------------------------------------------------

/** GA4 forbids personal data in event parameters; hashed user_data is the allowed channel. */
export const ga4Pii: Rule = (ctx) =>
  ctx.active
    .filter((x) => x.type === 'gaawe')
    .map((x) => ({
      tag: x,
      leaks: paramLeaves(x.parameters).filter(
        (l) => l.path.startsWith('eventSettingsTable') && /e_?mail|phone|telefon|tel_?nr|adress|address/i.test(l.name) && l.value,
      ),
    }))
    .filter((x) => x.leaks.length)
    .map(({ tag, leaks }) => ({
      rule: 'ga4-pii',
      key: tag.id,
      severity: 'warning' as const,
      title: t('piiTitle', { name: tag.name }),
      message: t('piiMessage'),
      entities: [ref(tag)],
      details: leaks.map((l) => `${l.name} = ${l.value}  (${describeSource(ctx.resolver.resolveValue(l.value).source)})`),
    }));

// --- 7. hygiene --------------------------------------------------------------------------

export const hygiene: Rule = (ctx) => {
  const findings: Finding[] = [];
  const noTrigger = ctx.active.filter((x) => x.firingTriggerIds.length === 0);
  if (noTrigger.length) {
    findings.push({ rule: 'tag-no-trigger', key: 'tag-no-trigger', severity: 'warning', title: t('noTriggerTitle', { count: noTrigger.length }), message: t('noTriggerMessage'), entities: noTrigger.map(ref), details: noTrigger.map((x) => x.name) });
  }
  const brokenTriggers = ctx.tags.filter((x) => [...x.firingTriggerIds, ...x.blockingTriggerIds].some((id) => !ctx.snap.triggers[id]));
  if (brokenTriggers.length) {
    findings.push({ rule: 'tag-missing-trigger', key: 'tag-missing-trigger', severity: 'critical', title: t('brokenTriggerTitle'), message: t('brokenTriggerMessage'), entities: brokenTriggers.map(ref), details: brokenTriggers.map((x) => x.name) });
  }
  const paused = ctx.tags.filter((x) => x.paused);
  if (paused.length) {
    findings.push({ rule: 'tag-paused', key: 'tag-paused', severity: 'info', title: t('pausedTitle', { count: paused.length }), message: t('pausedMessage'), entities: paused.map(ref), details: paused.map((x) => x.name) });
  }
  const usedTriggers = new Set(ctx.tags.flatMap((x) => [...x.firingTriggerIds, ...x.blockingTriggerIds]));
  const unusedTriggers = ctx.triggers.filter((x) => !usedTriggers.has(x.id) && Number(x.id) < 2147479553);
  if (unusedTriggers.length) {
    findings.push({ rule: 'unused-triggers', key: 'unused-triggers', severity: 'info', title: t('unusedTriggersTitle', { count: unusedTriggers.length }), message: t('unusedTriggersMessage'), entities: unusedTriggers.map(ref), details: unusedTriggers.map((x) => x.name) });
  }
  const unusedVariables = ctx.variables.filter((v) => usersOf(ctx, v.name).length === 0);
  if (unusedVariables.length) {
    findings.push({ rule: 'unused-variables', key: 'unused-variables', severity: 'info', title: t('unusedVariablesTitle', { count: unusedVariables.length }), message: t('unusedVariablesMessage'), entities: unusedVariables.map(ref), details: unusedVariables.map((v) => v.name) });
  }
  return findings;
};

// --- 8. naming -------------------------------------------------------------------------

export const naming: Rule = (ctx) => {
  const findings: Finding[] = [];
  for (const tag of ctx.active.filter((x) => x.type === 'gaawe')) {
    const eventName = paramLeaves(tag.parameters).find((l) => l.path === 'eventName')?.value;
    if (!eventName || Resolver.references(eventName).length) continue;
    // Same letters (addToCart vs add_to_cart) or one edit away; 2 edits only for long names (badge_view ≠ page_view).
    const close = GA4_EVENTS.find((g) => {
      if (g === eventName) return false;
      const d = levenshtein(g, eventName);
      return normalizeName(g) === normalizeName(eventName) || d === 1 || (d === 2 && g.length >= 12);
    });
    if (close) {
      findings.push({ rule: 'ga4-event-typo', key: tag.id, severity: 'warning', title: t('typoTitle', { event: eventName }), message: t('typoMessage', { close }), entities: [ref(tag)], details: [tag.name] });
    } else if (!/^[a-z][a-z0-9_]{0,39}$/.test(eventName)) {
      findings.push({ rule: 'ga4-event-format', key: tag.id, severity: 'warning', title: t('eventFormatTitle', { event: eventName }), message: t('eventFormatMessage'), entities: [ref(tag)], details: [tag.name] });
    }
  }

  let pattern: RegExp | null = null;
  try {
    pattern = ctx.settings.namingPattern ? new RegExp(ctx.settings.namingPattern) : null;
  } catch {
    pattern = null;
  }
  if (pattern) {
    for (const [kind, list] of [['tag', ctx.tags], ['trigger', ctx.triggers.filter((x) => Number(x.id) < 2147479553)], ['variable', ctx.variables]] as const) {
      const bad = (list as GtmEntity[]).filter((e) => !pattern!.test(e.name));
      if (!bad.length) continue;
      findings.push({
        rule: 'naming-convention',
        key: `naming-convention|${kind}`,
        severity: 'info',
        title: t('conventionTitle', { kind: kindLabel(kind), count: bad.length, total: list.length }),
        message: t('conventionMessage', { pattern: ctx.settings.namingPattern }),
        entities: bad.map(ref),
        details: bad.map((e) => e.name),
      });
    }
  }
  return findings;
};

// --- 9. consent mode -------------------------------------------------------------------
//
// Google tags honour Consent Mode signals on their own (in Advanced mode they send cookieless pings
// without consent), so additional consent requirements are NOT mandatory. They do, however, block a
// tag completely – so tags of the same platform with different settings behave differently.
// The rule therefore checks consistency within a platform, not presence of specific consent types.

/** Platform families whose tags should share one consent setup. */
const CONSENT_PLATFORM: Record<string, string> = {
  awct: 'Google Ads',
  sp: 'Google Ads',
  awud: 'Google Ads',
  gclidw: 'Google Ads',
  flc: 'Floodlight',
  fls: 'Floodlight',
  gaawe: 'GA4',
  googtag: 'Google tag',
  baut: 'Microsoft Ads',
};

function consentPlatform(tag: GtmTag, ctx: LintContext): string | null {
  if (CONSENT_PLATFORM[tag.type]) return CONSENT_PLATFORM[tag.type];
  if (tag.type.startsWith('cvt_')) return t('template', { name: typeName(ctx, tag.type) }); // same template = same vendor
  return null; // Custom HTML etc.: purpose unknown
}

function consentSignature(tag: GtmTag): string {
  const c = tag.consent;
  if (c?.status === 'needed') return t('consentRequires', { types: [...c.types].sort().join(', ') || t('consentEmptyList') });
  if (c?.status === 'notNeeded') return t('consentNotNeeded');
  return t('consentNotSet');
}

/** Internal tools (FAST …) that need no consent, matched by template or tag name. */
function isConsentExempt(tag: GtmTag, ctx: LintContext): boolean {
  // Whole-word match, so "FAST" doesn't hit e.g. "Breakfast".
  const words = new Set(`${typeName(ctx, tag.type)} ${tag.name}`.toLowerCase().split(/[^a-z0-9äöüß]+/));
  return ctx.settings.consentExempt.some((p) => p && p.toLowerCase().split(/\s+/).every((w) => words.has(w)));
}

export const consent: Rule = (ctx) => {
  const groups = new Map<string, GtmTag[]>();
  const unnecessary: GtmTag[] = [];
  for (const tag of ctx.active) {
    const triggers = tag.firingTriggerIds.map((id) => ctx.snap.triggers[id]);
    if (triggers.some((x) => x?.type === 'consentInit')) continue; // CMP / consent default tags
    if (isConsentExempt(tag, ctx)) {
      if (tag.consent?.status === 'needed') unnecessary.push(tag);
      continue;
    }
    const platform = consentPlatform(tag, ctx);
    if (platform) groups.set(platform, [...(groups.get(platform) ?? []), tag]);
  }

  const findings: Finding[] = [];
  if (unnecessary.length) {
    findings.push({
      rule: 'consent-exempt-blocked',
      key: 'consent-exempt-blocked',
      severity: 'info',
      title: t('consentExemptTitle', { count: unnecessary.length }),
      message: t('consentExemptMessage', { tools: ctx.settings.consentExempt.join(', ') }),
      entities: unnecessary.map(ref),
      details: unnecessary.map((x) => `${x.name}: ${consentSignature(x)}`),
    });
  }
  // Consent setup is the client's decision, so this is an informational overview, not a warning:
  // per platform, which tags have additional consent requirements and which don't.
  const overview: string[] = [];
  const summary: string[] = [];
  for (const [platform, tags] of [...groups].sort((a, b) => a[0].localeCompare(b[0], 'pl'))) {
    const bySignature = new Map<string, GtmTag[]>();
    for (const x of tags) bySignature.set(consentSignature(x), [...(bySignature.get(consentSignature(x)) ?? []), x]);
    const variants = [...bySignature].sort((a, b) => b[1].length - a[1].length);
    summary.push(`${platform}: ${variants.map(([s, list]) => `${s} (${list.length})`).join(', ')}`);
    overview.push(`▸ ${platform}`, ...variants.flatMap(([signature, list]) => [`    ${signature} (${list.length})`, ...list.map((x) => `      ${x.name}`)]));
  }
  if (overview.length) {
    findings.push({
      rule: 'consent-overview',
      key: 'consent-overview',
      severity: 'info',
      title: t('consentOverviewTitle', { summary: summary.join(' · ') }),
      message: t('consentOverviewMessage'),
      entities: [...groups.values()].flat().map(ref),
      details: overview,
    });
  }
  return findings;
};

export const ALL_RULES: Rule[] = [sourceConsistency, duplicateTags, duplicateVariables, dataTypes, conversions, ga4Pii, consent, naming, namingTaxonomy, hygiene];

// --- helpers -----------------------------------------------------------------------------

/** Plural label of an entity kind ("Tags", "Triggers", "Variables") in the active language. */
export function kindLabel(kind: EntityKind): string {
  return t(kind === 'tag' ? 'kindTags' : kind === 'trigger' ? 'kindTriggers' : 'kindVariables');
}

function unique(refs: EntityRef[]): EntityRef[] {
  const seen = new Set<string>();
  return refs.filter((r) => !seen.has(`${r.kind}:${r.id}`) && seen.add(`${r.kind}:${r.id}`));
}

function intersectAll(lists: string[][]): string[] {
  if (!lists.length) return [];
  return lists.reduce((acc, l) => acc.filter((x) => l.includes(x)));
}

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}
