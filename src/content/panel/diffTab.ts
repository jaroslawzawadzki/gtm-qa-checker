// "Diff" tab: choose what to compare, run the diff, show the result.
// The tab keeps its own DOM between tab switches so form selections and results survive.
import type { DiffRequest, DiffResult, EntityDiff, FieldChange } from '../../diff/diffEngine';
import type { EntityKind } from '../../shared/types';
import type { Controller } from '../content';
import { fmtTime, h } from './dom';
import { t } from './i18n';

type Mode = DiffRequest['mode'];

const MAX_VALUE = 600;
// Labels are resolved at render time (the language can change at runtime).
const kindLabel = (kind: EntityKind) => t(({ tag: 'tags', trigger: 'triggers', variable: 'variables' } as const)[kind]);
const statusLabel = (status: EntityDiff['status']) => t(({ added: 'statusAdded', modified: 'statusModified', removed: 'statusDeleted' } as const)[status]);
const STATUS_CLASS = { added: 'ok', modified: 'warn', removed: 'crit' } as const;

export class DiffTab {
  readonly element = h('div');
  private readonly formBox = h('section');
  private readonly status = h('div', { class: 'status' });
  private readonly results = h('div');
  private mode: Mode = 'workspace';
  private wsVersion = '';
  private rangeFrom = '';
  private rangeTo = '';
  private hours = 24;
  private hoursWithWorkspace = false;
  private running = false;

  constructor(private readonly ctl: Controller) {
    this.element.append(this.formBox, this.results);
  }

  /** Called whenever the tab becomes visible: refreshes version pickers, keeps results. */
  show(): void {
    this.renderForm();
    if (this.ctl.lastDiff && !this.results.childElementCount) this.renderResult(this.ctl.lastDiff);
  }

  /** After a language change: rebuilds the form and the result from ctl.lastDiff. */
  refresh(): void {
    this.setStatus('');
    this.renderForm();
    if (this.ctl.lastDiff) this.renderResult(this.ctl.lastDiff);
    else this.results.replaceChildren();
  }

  private versions() {
    return [...this.ctl.store.versionHeaders.values()].filter((v) => !v.deleted).sort((a, b) => Number(b.versionId) - Number(a.versionId));
  }

  private renderForm(): void {
    const { store } = this.ctl;
    const workspaceId = store.context.workspaceId;
    const versions = this.versions();
    const baseVersion = workspaceId ? store.workspaces.get(workspaceId)?.baseVersionId : undefined;
    this.wsVersion ||= baseVersion ?? versions[0]?.versionId ?? '';
    this.rangeTo ||= versions[0]?.versionId ?? '';
    this.rangeFrom ||= versions[1]?.versionId ?? '';

    const versionSelect = (value: string, onChange: (v: string) => void) => {
      const select = h(
        'select',
        {},
        ...versions.map((v) =>
          h('option', { value: v.versionId, selected: v.versionId === value }, `v${v.versionId}${v.name ? ` – ${v.name}` : ''}${v.versionId === baseVersion ? ` (${t('baseBadge')})` : ''}`),
        ),
      ) as HTMLSelectElement;
      select.addEventListener('change', () => onChange(select.value));
      return select;
    };

    const modeButton = (mode: Mode, label: string) =>
      h('button', { class: `btn small${this.mode === mode ? ' primary' : ''}`, onClick: () => ((this.mode = mode), this.renderForm()) }, label);

    let fields: Node[];
    if (this.mode === 'workspace') {
      fields = workspaceId
        ? [h('label', {}, t('diffWsCompare', { id: workspaceId })), versionSelect(this.wsVersion, (v) => (this.wsVersion = v))]
        : [h('p', { class: 'small muted' }, t('diffOpenWs'))];
    } else if (this.mode === 'range') {
      fields = [
        h('label', {}, t('diffFrom')),
        versionSelect(this.rangeFrom, (v) => (this.rangeFrom = v)),
        h('label', {}, t('diffTo')),
        versionSelect(this.rangeTo, (v) => (this.rangeTo = v)),
      ];
    } else {
      const hoursInput = h('input', { type: 'text', inputmode: 'numeric', value: String(this.hours) }) as HTMLInputElement;
      hoursInput.addEventListener('change', () => (this.hours = Math.max(1, Number(hoursInput.value) || 24)));
      const preset = (n: number) => h('button', { class: 'btn small', onClick: () => ((this.hours = n), this.renderForm()) }, `${n} h`);
      const withWs = h('input', { type: 'checkbox', checked: this.hoursWithWorkspace, disabled: !workspaceId }) as HTMLInputElement;
      withWs.addEventListener('change', () => (this.hoursWithWorkspace = withWs.checked));
      fields = [
        h('label', {}, t('diffLastHours')),
        h('div', { class: 'row' }, hoursInput, preset(24), preset(48), preset(168)),
        h('label', { class: 'inline' }, withWs, ` ${t('diffWithWs')}`),
      ];
    }

    const runBtn = h('button', { class: 'btn primary', disabled: this.running, onClick: () => void this.run() }, t('diffRun'));
    this.formBox.replaceChildren(
      h('h3', {}, t('diffScope')),
      h('div', { class: 'row' }, modeButton('workspace', t('diffModeWorkspace')), modeButton('range', t('diffModeRange')), modeButton('hours', t('diffModeHours'))),
      ...fields,
      h('div', { class: 'row', style: 'margin-top:12px' }, runBtn),
      this.status,
    );
  }

  private request(): DiffRequest {
    const workspaceId = this.ctl.store.context.workspaceId;
    if (this.mode === 'workspace') {
      if (!workspaceId) throw new Error(t('diffNoWs'));
      return { mode: 'workspace', workspaceId, versionId: this.wsVersion || undefined };
    }
    if (this.mode === 'range') return { mode: 'range', fromVersionId: this.rangeFrom, toVersionId: this.rangeTo };
    return { mode: 'hours', hours: this.hours, now: Date.now(), workspaceId: this.hoursWithWorkspace ? workspaceId : undefined };
  }

  private async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.renderForm();
    this.setStatus(t('preparing'));
    try {
      const result = await this.ctl.runDiff(this.request(), (p) =>
        this.setStatus(`${p.label}${p.total ? ` – ${p.done}/${p.total}` : '…'}`),
      );
      this.setStatus(t('diffDone', { n: result.entities.length }), true);
      this.renderResult(result);
    } catch (err) {
      this.setStatus((err as Error).message, false);
      // Don't leave a previous result under an error message – it would look like the answer.
      this.results.replaceChildren();
      this.ctl.lastDiff = null;
    } finally {
      this.running = false;
      this.renderForm();
    }
  }

  private setStatus(text: string, ok?: boolean): void {
    this.status.textContent = text;
    this.status.className = `status${ok === undefined ? '' : ok ? ' ok' : ' err'}`;
  }

  // --- result ----------------------------------------------------------------

  private renderResult(r: DiffResult): void {
    const nodes: Node[] = [
      h(
        'section',
        {},
        h('h3', {}, t('result')),
        h('p', {}, r.plan.description),
        h('p', { class: 'small' }, h('strong', {}, r.plan.base.label), ' → ', h('strong', {}, r.plan.target.label)),
        ...r.warnings.map((w) => h('p', { class: 'small' }, h('span', { class: 'badge warn' }, t('warningBadge')), ' ', w)),
        this.renderSummary(r),
      ),
    ];

    if (r.timeline.length) {
      nodes.push(
        h(
          'section',
          {},
          h(
            'details',
            {},
            h('summary', {}, t('diffTimeline', { n: r.timeline.length })),
            h(
              'ul',
              { class: 'list' },
              ...r.timeline.map((v) =>
                h(
                  'li',
                  {},
                  h('span', { class: 'name' }, h('strong', {}, `v${v.versionId}`), v.name ? ` ${v.name}` : '', h('div', { class: 'small muted' }, [fmtTime(v.createdAt), v.author].filter(Boolean).join(' · '))),
                  h('span', { class: 'type' }, t('diffChangesCount', { n: v.changes.length })),
                ),
              ),
            ),
          ),
        ),
      );
    }

    if (!r.entities.length) nodes.push(h('div', { class: 'empty' }, t('diffNoDiff')));
    for (const kind of ['tag', 'trigger', 'variable'] as const) {
      const items = r.entities.filter((e) => e.kind === kind);
      if (items.length) nodes.push(h('section', {}, h('h3', {}, `${kindLabel(kind)} (${items.length})`), ...items.map((e) => this.renderEntity(e))));
    }

    if (r.touchedButUnchanged.length) {
      nodes.push(
        h(
          'section',
          {},
          h('h3', {}, t('diffTouched')),
          h('p', { class: 'small muted' }, t('diffTouchedHint')),
          h('ul', { class: 'list' }, ...r.touchedButUnchanged.map((c) => h('li', {}, h('span', { class: 'name' }, c.name), h('span', { class: 'type' }, c.entityType)))),
        ),
      );
    }
    this.results.replaceChildren(...nodes);
  }

  private renderSummary(r: DiffResult): Node {
    const count = (kind: EntityKind, status: EntityDiff['status']) => r.entities.filter((e) => e.kind === kind && e.status === status).length;
    const cell = (n: number, cls: string) => h('td', { class: 'num' }, n ? h('span', { class: `badge ${cls}` }, n) : '–');
    return h(
      'table',
      {},
      h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', { class: 'num' }, t('diffAdded')), h('th', { class: 'num' }, t('diffModified')), h('th', { class: 'num' }, t('diffRemoved')))),
      h(
        'tbody',
        {},
        ...(['tag', 'trigger', 'variable'] as const).map((k) =>
          h('tr', {}, h('td', {}, kindLabel(k)), cell(count(k, 'added'), 'ok'), cell(count(k, 'modified'), 'warn'), cell(count(k, 'removed'), 'crit')),
        ),
      ),
    );
  }

  private renderEntity(e: EntityDiff): Node {
    const body =
      e.status === 'removed'
        ? h('p', { class: 'small muted' }, t('entityRemoved'))
        : e.status === 'added'
          ? h('pre', { class: 'params' }, e.fields.map((f) => `${f.field} = ${clip(f.after)}`).join('\n'))
          : h(
              'table',
              { class: 'fields' },
              h('thead', {}, h('tr', {}, h('th', {}, t('field')), h('th', {}, t('before')), h('th', {}, t('after')))),
              h('tbody', {}, ...e.fields.map((f) => this.renderField(f))),
            );
    return h(
      'details',
      { class: 'diff-entity' },
      h(
        'summary',
        {},
        h('span', { class: `badge ${STATUS_CLASS[e.status]}` }, statusLabel(e.status)),
        ' ',
        h('span', { class: 'name' }, e.name),
        h('span', { class: 'type' }, [this.ctl.store.templates.get(e.type) ?? e.type, e.touchedIn.length ? `v${e.touchedIn.join(', v')}` : ''].filter(Boolean).join(' · ')),
      ),
      body,
    );
  }

  private renderField(f: FieldChange): Node {
    return h(
      'tr',
      {},
      h('td', {}, f.field),
      h('td', {}, h('pre', { class: 'val before' }, f.before === undefined ? '—' : clip(f.before))),
      h('td', {}, h('pre', { class: 'val after' }, f.after === undefined ? '—' : clip(f.after))),
    );
  }
}

function clip(value?: string): string {
  if (value === undefined) return '';
  return value.length > MAX_VALUE ? `${value.slice(0, MAX_VALUE)}… ${t('chars', { n: value.length })}` : value;
}
