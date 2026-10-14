// Resolves {{Variable}} references to where the value really comes from
// (dataLayer key, constant, JS, cookie, …), following nested references.
import type { GtmParameter, GtmVariable, Snapshot } from '../shared/types';
import { t } from './i18n';

export type Source =
  | { kind: 'dataLayer'; path: string; defaultValue?: string }
  | { kind: 'constant'; value: string }
  | { kind: 'jsVariable'; name: string }
  | { kind: 'customJs'; code: string }
  | { kind: 'cookie'; name: string }
  | { kind: 'url'; component: string }
  | { kind: 'lookup'; input: Source; variable: string }
  | { kind: 'builtin'; name: string }
  | { kind: 'text'; value: string } // literal typed straight into the tag
  | { kind: 'mixed'; value: string; parts: Source[] } // text + references, e.g. "{{value}} PLN"
  | { kind: 'missing'; name: string }
  | { kind: 'other'; type: string; variable: string };

export interface Resolved {
  source: Source;
  /** Variable names followed to reach the source, outermost first. */
  via: string[];
}

const REF = /\{\{([^{}]+)\}\}/g;
const SINGLE_REF = /^\{\{([^{}]+)\}\}$/;

/** GTM built-in variables (enabled per container; they are not part of the variable list). */
const BUILT_IN = new Set([
  'Event', '_event', 'Page URL', 'Page Hostname', 'Page Path', 'Referrer', 'Container ID', 'Container Version',
  'Debug Mode', 'Random Number', 'HTML ID', 'Environment Name', 'Click Element', 'Click Classes', 'Click ID',
  'Click Target', 'Click URL', 'Click Text', 'Form Element', 'Form Classes', 'Form ID', 'Form Target', 'Form URL',
  'Form Text', 'Error Message', 'Error URL', 'Error Line', 'Debug Mode', 'New History Fragment', 'Old History Fragment',
  'New History State', 'Old History State', 'History Source', 'Video Provider', 'Video URL', 'Video Title',
  'Video Duration', 'Video Percent', 'Video Visible', 'Video Status', 'Video Current Time', 'Scroll Depth Threshold',
  'Scroll Depth Units', 'Scroll Direction', 'Percent Visible', 'On-Screen Duration', 'Element Visibility Ratio',
  'Client Name', 'Event Name', 'Request Path', 'Request Method', 'Query String', 'Client Hostname',
]);

export class Resolver {
  private readonly byName = new Map<string, GtmVariable>();
  private readonly cache = new Map<string, Resolved>();

  constructor(snapshot: Snapshot) {
    for (const v of Object.values(snapshot.variables)) this.byName.set(v.name, v);
  }

  variable(name: string): GtmVariable | undefined {
    return this.byName.get(name);
  }

  isKnownReference(name: string): boolean {
    return this.byName.has(name) || BUILT_IN.has(name);
  }

  /** All {{names}} referenced in a parameter value. */
  static references(value: string | undefined): string[] {
    return value ? [...value.matchAll(REF)].map((m) => m[1]) : [];
  }

  /** Resolves a raw parameter value as typed in a tag. */
  resolveValue(value: string): Resolved {
    const single = value.match(SINGLE_REF);
    if (single) return this.resolveName(single[1]);
    const refs = Resolver.references(value);
    if (!refs.length) return { source: { kind: 'text', value }, via: [] };
    return { source: { kind: 'mixed', value, parts: refs.map((r) => this.resolveName(r).source) }, via: refs };
  }

  resolveName(name: string, depth = 0): Resolved {
    const cached = this.cache.get(name);
    if (cached) return cached;
    const v = this.byName.get(name);
    let result: Resolved;
    if (!v) {
      result = { source: BUILT_IN.has(name) ? { kind: 'builtin', name } : { kind: 'missing', name }, via: [] };
    } else {
      const inner = this.fromVariable(v, depth);
      result = { source: inner.source, via: [name, ...inner.via] };
    }
    this.cache.set(name, result);
    return result;
  }

  private fromVariable(v: GtmVariable, depth: number): Resolved {
    const p = (key: string) => param(v.parameters, key);
    switch (v.type) {
      case 'v': {
        const defaultValue = p('setDefaultValue') === 'true' ? p('defaultValue') : undefined;
        return { source: { kind: 'dataLayer', path: p('name') ?? '?', defaultValue }, via: [] };
      }
      case 'c': {
        const value = p('value') ?? '';
        // Constants sometimes just wrap another variable.
        if (depth < 5 && SINGLE_REF.test(value)) {
          const inner = this.resolveName(value.slice(2, -2), depth + 1);
          return { source: inner.source, via: inner.via };
        }
        return { source: { kind: 'constant', value }, via: [] };
      }
      case 'j':
        return { source: { kind: 'jsVariable', name: p('name') ?? '?' }, via: [] };
      case 'jsm':
        return { source: { kind: 'customJs', code: p('javascript') ?? '' }, via: [] };
      case 'k':
        return { source: { kind: 'cookie', name: p('name') ?? '?' }, via: [] };
      case 'u':
        // QUERY variables differ by the parameter they read.
        return { source: { kind: 'url', component: [p('component') ?? 'URL', p('queryKey')].filter(Boolean).join(' ') }, via: [] };
      case 'smm':
      case 'remm': {
        const input = p('input') ?? '';
        const inner = depth < 5 ? this.resolveValue(input) : { source: { kind: 'text', value: input } as Source, via: [] };
        return { source: { kind: 'lookup', input: inner.source, variable: v.name }, via: [] };
      }
      default:
        return { source: { kind: 'other', type: v.type, variable: v.name }, via: [] };
    }
  }
}

export function param(params: GtmParameter[], key: string): string | undefined {
  return params.find((x) => x.key === key)?.value;
}

/** Stable key: two sources with the same key deliver the same data. */
export function sourceKey(s: Source): string {
  switch (s.kind) {
    case 'dataLayer':
      return `dataLayer:${s.path}`;
    case 'constant':
    case 'text':
      return `value:${s.value}`;
    case 'jsVariable':
      return `js:${s.name}`;
    case 'customJs':
      return `customJs:${s.code.replace(/\s+/g, ' ').trim()}`;
    case 'cookie':
      return `cookie:${s.name}`;
    case 'url':
      return `url:${s.component}`;
    case 'lookup':
      return `lookup:${s.variable}`;
    case 'builtin':
      return `builtin:${s.name}`;
    case 'mixed':
      return `mixed:${s.value}`;
    case 'missing':
      return `missing:${s.name}`;
    case 'other':
      return `other:${s.variable}`;
  }
}

export function describeSource(s: Source): string {
  switch (s.kind) {
    case 'dataLayer':
      return s.defaultValue !== undefined ? t('srcDataLayerDefault', { path: s.path, value: s.defaultValue }) : t('srcDataLayer', { path: s.path });
    case 'constant':
      return t('srcConstant', { value: s.value });
    case 'text':
      return t('srcText', { value: s.value });
    case 'jsVariable':
      return t('srcJsVariable', { name: s.name });
    case 'customJs':
      return `Custom JS (${s.code.replace(/\s+/g, ' ').trim().slice(0, 60)}…)`;
    case 'cookie':
      return `cookie ${s.name}`;
    case 'url':
      return `URL (${s.component})`;
    case 'lookup':
      return t('srcLookup', { variable: s.variable, input: describeSource(s.input) });
    case 'builtin':
      return t('srcBuiltin', { ref: `{{${s.name}}}` });
    case 'mixed':
      return t('srcMixed', { value: s.value });
    case 'missing':
      return t('srcMissing', { ref: `{{${s.name}}}` });
    case 'other':
      return t('srcOther', { variable: s.variable, type: s.type });
  }
}

/**
 * Language-independent text of a source (names, paths, values, code) for keyword matching,
 * so detection does not depend on the UI language.
 */
export function sourceText(s: Source): string {
  switch (s.kind) {
    case 'dataLayer':
      return `dataLayer → ${s.path}${s.defaultValue !== undefined ? ` "${s.defaultValue}"` : ''}`;
    case 'constant':
    case 'text':
    case 'mixed':
      return `"${s.value}"`;
    case 'jsVariable':
      return s.name;
    case 'customJs':
      return `Custom JS (${s.code.replace(/\s+/g, ' ').trim().slice(0, 60)}…)`;
    case 'cookie':
      return `cookie ${s.name}`;
    case 'url':
      return `URL (${s.component})`;
    case 'lookup':
      return `${s.variable} ← ${sourceText(s.input)}`;
    case 'builtin':
    case 'missing':
      return `{{${s.name}}}`;
    case 'other':
      return `${s.variable} (${s.type})`;
  }
}
