// Actively loads complete GTM data (lists + per-entity details) through read-only GETs
// executed in the page with the user's session.
import { endpoints, type ScopeRef } from '../adapters/gtmApiAdapter';
import type { ScopeKey } from '../shared/types';
import type { GtmStore } from './store';
import { defineMessages } from '../i18n';

const t = defineMessages({
  en: {
    lists: 'Lists of tags, triggers and variables',
    version: 'Version {id}',
    details: 'Tag and variable details',
  },
  de: {
    lists: 'Listen der Tags, Trigger und Variablen',
    version: 'Version {id}',
    details: 'Details der Tags und Variablen',
  },
  pl: {
    lists: 'Listy tagów, reguł i zmiennych',
    version: 'Wersja {id}',
    details: 'Szczegóły tagów i zmiennych',
  },
});

export interface Progress {
  label: string;
  done: number;
  total: number;
}

type Get = (url: string) => Promise<void>;
type OnProgress = (p: Progress) => void;

const DETAIL_CONCURRENCY = 4;

export class GtmLoader {
  constructor(
    private readonly store: GtmStore,
    /** Fetches a URL, feeds the response to the adapter/store; throws on HTTP errors. */
    private readonly get: Get,
  ) {}

  async loadVersionList(): Promise<void> {
    await this.get(endpoints.versionList(this.store.context));
  }

  /** Workspace lists, pending changes and full parameters of every tag and variable. */
  async loadWorkspace(workspaceId: string, onProgress: OnProgress = () => undefined): Promise<void> {
    const ctx = this.store.context;
    const ref: ScopeRef = { workspaceId };
    await this.store.batch(async () => {
      onProgress({ label: t('lists'), done: 0, total: 1 });
      await Promise.all([
        this.get(endpoints.workspace(ctx, workspaceId)),
        this.get(endpoints.workspaceChanges(ctx, workspaceId)),
        this.get(endpoints.workspaceTemplates(ctx, workspaceId)),
        this.get(endpoints.list(ctx, ref, 'tag')),
        this.get(endpoints.list(ctx, ref, 'trigger')),
        this.get(endpoints.list(ctx, ref, 'variable')),
      ]);
      this.store.markComplete(`workspace:${workspaceId}`);
      await this.loadDetails(`workspace:${workspaceId}`, ref, onProgress);
    });
  }

  /** Full version content; details are fetched only for entities not already cached. */
  async loadVersion(versionId: string, onProgress: OnProgress = () => undefined): Promise<void> {
    const ctx = this.store.context;
    await this.store.batch(async () => {
      onProgress({ label: t('version', { id: versionId }), done: 0, total: 1 });
      await this.get(endpoints.version(ctx, versionId));
      await this.loadDetails(`version:${versionId}`, { versionId }, onProgress);
    });
  }

  /** Workspace name and base version only. */
  async loadWorkspaceInfo(workspaceId: string): Promise<void> {
    await this.get(endpoints.workspace(this.store.context, workspaceId));
  }

  /** Version content without entity details – enough for its header and change list. */
  async loadVersionSummary(versionId: string): Promise<void> {
    await this.get(endpoints.version(this.store.context, versionId));
  }

  private async loadDetails(scope: ScopeKey, ref: ScopeRef, onProgress: OnProgress): Promise<void> {
    const ctx = this.store.context;
    const queue = this.store.incompleteEntities(scope);
    const total = queue.length;
    let done = 0;
    onProgress({ label: t('details'), done, total });

    const worker = async () => {
      for (let entity = queue.shift(); entity; entity = queue.shift()) {
        try {
          await this.get(endpoints.detail(ctx, ref, entity.kind, entity.id));
          // The detail view is authoritative even when the entity really has no parameters.
          this.store.markParamsComplete(scope, entity.kind, entity.id);
        } catch {
          // Leave it incomplete; the user can retry.
        }
        onProgress({ label: t('details'), done: ++done, total });
      }
    };
    await Promise.all(Array.from({ length: Math.min(DETAIL_CONCURRENCY, total) }, worker));
  }
}
