// Settings section: agency exceptions (AI rules + suppressed QA findings), with JSON export/import.
import { addAiRule, exportJson, importJson, loadExceptions, removeException } from '../../shared/exceptions';
import type { Controller } from '../content';
import { fmtTime, h } from './dom';
import { t } from './i18n';

export function exceptionsSection(ctl: Controller): HTMLElement {
  const box = h('section', {});
  const status = h('div', { class: 'status' });

  const setStatus = (text: string, ok: boolean) => {
    status.textContent = text;
    status.className = `status ${ok ? 'ok' : 'err'}`;
  };

  const afterChange = async () => {
    await ctl.reapplyExceptions();
    await render();
  };

  const render = async () => {
    const list = await loadExceptions();

    const newRule = h('input', { type: 'text', placeholder: t('excRulePlaceholder') }) as HTMLInputElement;
    const fileInput = h('input', { type: 'file', accept: '.json,application/json', hidden: true }) as HTMLInputElement;
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      try {
        const { added, skipped } = await importJson(await file.text());
        await afterChange();
        setStatus(t('excImported', { added, skipped }), true);
      } catch (err) {
        setStatus((err as Error).message, false);
      }
    });

    const download = () => {
      const blob = new Blob([exportJson(list)], { type: 'application/json' });
      const a = h('a', { href: URL.createObjectURL(blob), download: `${t('excFilePrefix')}-${new Date().toISOString().slice(0, 10)}.json` });
      box.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 120_000);
    };

    box.replaceChildren(
      h('h3', {}, t('excTitle')),
      h('p', { class: 'small muted' }, t('excNote')),
      h(
        'div',
        { class: 'row' },
        h('button', { class: 'btn', onClick: download }, t('excExport', { n: list.aiRules.length + list.suppressions.length })),
        h('button', { class: 'btn', onClick: () => fileInput.click() }, t('excImport')),
        fileInput,
      ),
      status,

      h('label', {}, t('aiRules', { n: list.aiRules.length })),
      h(
        'ul',
        { class: 'list' },
        ...list.aiRules.map((r) =>
          h(
            'li',
            {},
            h('span', { class: 'name small' }, r.text),
            h('button', { class: 'btn small', onClick: async () => (await removeException('aiRule', r.id), await render()) }, t('remove')),
          ),
        ),
      ),
      h(
        'div',
        { class: 'row', style: 'margin-top:6px' },
        newRule,
        h(
          'button',
          {
            class: 'btn small',
            onClick: async () => {
              const added = await addAiRule(newRule.value);
              if (added) await render();
              else setStatus(newRule.value.trim() ? t('ruleExists') : t('enterRule'), false);
            },
          },
          t('add'),
        ),
      ),

      h('label', {}, t('hiddenFindings', { n: list.suppressions.length })),
      list.suppressions.length
        ? h(
            'ul',
            { class: 'list' },
            ...list.suppressions.map((s) =>
              h(
                'li',
                {},
                h(
                  'span',
                  { class: 'name small' },
                  s.title,
                  h(
                    'div',
                    { class: 'muted' },
                    [s.containerId ? t('ctxContainer', { id: s.publicId ?? s.containerId }) : t('allContainers'), s.reason, fmtTime(s.createdAt)].filter(Boolean).join(' · '),
                  ),
                ),
                h('button', { class: 'btn small', onClick: async () => (await removeException('suppression', s.id), await afterChange()) }, t('remove')),
              ),
            ),
          )
        : h('p', { class: 'small muted' }, t('noHidden')),
    );
  };

  void render();
  return box;
}
