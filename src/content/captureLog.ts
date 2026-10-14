// Ring buffer of captured GTM responses, used by the Debug tab to tune gtmApiAdapter.ts.
import type { CaptureVia } from '../shared/messages';
import type { DetectedCounts } from '../shared/types';

export interface CaptureEntry {
  id: number;
  url: string;
  method: string;
  status: number;
  via: CaptureVia;
  ts: number;
  size: number;
  parsed: boolean;
  detected: DetectedCounts;
  text: string;
}

const MAX_ENTRIES = 150;

export class CaptureLog {
  readonly entries: CaptureEntry[] = [];
  private nextId = 1;
  private readonly listeners = new Set<() => void>();

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  add(entry: Omit<CaptureEntry, 'id'>): CaptureEntry {
    const full = { ...entry, id: this.nextId++ };
    this.entries.push(full);
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    this.listeners.forEach((fn) => fn());
    return full;
  }

  clear(): void {
    this.entries.length = 0;
    this.listeners.forEach((fn) => fn());
  }

  toJson(): string {
    return JSON.stringify(this.entries);
  }
}

export function hasEntities(d: DetectedCounts): boolean {
  return d.tags + d.triggers + d.variables + d.versions + d.headers > 0;
}
