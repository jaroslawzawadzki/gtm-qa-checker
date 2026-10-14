// Builds the sanitized JSON sent to the LLM: metadata and parameter structure only.
// Custom HTML / Custom JS code, secrets and e-mail addresses never leave the browser.
import type { DiffResult, FieldChange } from '../diff/diffEngine';
import type { LintResult } from '../qa/linter';
import type { GtmContext } from '../shared/types';

const MAX_VALUE = 160;
const MAX_DETAILS = 6;
const CODE_FIELD = /(^|\.)(html|javascript|code|script)$/i;
const SECRET_FIELD = /api[_-]?key|token|secret|password|passwd|auth/i;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const CODE_TEXT = /<script|<\/?[a-z]+[\s>]|function\s*\(|=>|document\.|window\./i;

export function sanitizeText(text: string): string {
  return text
    .replace(/Custom JS \([^)]*…\)/g, 'Custom JS')
    .replace(EMAIL, '[email]')
    .slice(0, 400);
}

function sanitizeValue(field: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (CODE_FIELD.test(field) || CODE_TEXT.test(value)) return `[code removed – ${value.length} chars]`;
  if (SECRET_FIELD.test(field)) return '[hidden]';
  const clean = value.replace(EMAIL, '[email]');
  return clean.length > MAX_VALUE ? `${clean.slice(0, MAX_VALUE)}…` : clean;
}

function sanitizeField(f: FieldChange) {
  return { field: f.field, before: sanitizeValue(f.field, f.before), after: sanitizeValue(f.field, f.after) };
}

export function buildLlmPayload(context: GtmContext, diff: DiffResult | null, lint: LintResult | null, templates: Map<string, string>) {
  return {
    container: context.publicId ?? context.containerId,
    diff: diff && {
      scope: diff.plan.description,
      from: diff.plan.base.label,
      to: diff.plan.target.label,
      publications: diff.timeline.map((t) => ({ version: t.versionId, name: t.name, changes: t.changes.length })),
      changes: diff.entities.map((e) => ({
        kind: e.kind,
        name: e.name,
        type: templates.get(e.type) ?? e.type,
        status: e.status,
        // Added entities: only the shape (field names), modified: the changed values.
        fields: e.status === 'modified' ? e.fields.map(sanitizeField) : e.fields.map((f) => f.field),
      })),
      revertedOrNetZero: diff.touchedButUnchanged.map((c) => c.name),
    },
    qa: lint && {
      scope: lint.scopeLabel,
      counts: lint.counts,
      findings: lint.findings
        .filter((f) => f.severity !== 'info')
        .map((f) => ({ severity: f.severity, title: sanitizeText(f.title), details: f.details.slice(0, MAX_DETAILS).map(sanitizeText) })),
      // Names are included so the model never has to guess which tag a finding refers to.
      info: lint.findings
        .filter((f) => f.severity === 'info')
        .map((f) => ({ title: sanitizeText(f.title), entities: f.entities.slice(0, MAX_DETAILS).map((e) => e.name), more: Math.max(0, f.entities.length - MAX_DETAILS) })),
      sst: lint.sst && {
        hosts: lint.sst.hosts,
        routes: lint.sst.routes.map((r) => ({ bridge: r.bridge, tag: r.tag.name, events: r.events, fields: r.fields, userData: r.userData })),
      },
    },
  };
}
