// Applies "not an error" exceptions to a lint result. Works on the unfiltered findings, so adding or
// removing an exception can be re-applied instantly without re-running QA. Matching uses the
// language-independent Finding.key, so exceptions survive a language switch.
import type { Suppression } from '../shared/exceptions';
import { AGGREGATE_RULES, countSeverities, narrow, type LintResult } from './linter';
import type { EntityRef, Finding } from './rules';

/** Rules whose findings change as entities come and go – matched by rule + entities only. */
const KEY_INDEPENDENT = new Set([...AGGREGATE_RULES, 'consent-overview']);

export const entityKey = (e: Pick<EntityRef, 'kind' | 'name'>) => `${e.kind}:${e.name}`;

export interface HiddenFinding {
  finding: Finding;
  suppressions: Suppression[];
}

export function applySuppressions(result: LintResult, suppressions: Suppression[], containerId?: string): LintResult {
  const visible: Finding[] = [];
  const hidden: HiddenFinding[] = [];

  for (const f of result.allFindings) {
    const matching = suppressions.filter(
      (s) =>
        s.rule === f.rule &&
        (!s.containerId || s.containerId === containerId) &&
        (KEY_INDEPENDENT.has(f.rule) || s.findingKey === f.key),
    );
    if (!matching.length) {
      visible.push(f);
      continue;
    }
    const covered = new Set(matching.flatMap((s) => s.entities));
    const remaining = f.entities.filter((e) => !covered.has(entityKey(e)));
    if (!remaining.length) hidden.push({ finding: f, suppressions: matching });
    // Aggregate findings resurface with only the new entities; others resurface whole when new entities appear.
    else if (AGGREGATE_RULES.has(f.rule)) visible.push(narrow(f, new Set(remaining.map((e) => `${e.kind}:${e.id}`))));
    else visible.push(f);
  }

  return { ...result, findings: visible, hidden, counts: countSeverities(visible) };
}
