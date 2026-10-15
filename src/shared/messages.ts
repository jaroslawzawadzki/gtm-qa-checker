// window.postMessage protocol between injected.js (MAIN world) and content.js (isolated world),
// plus chrome.runtime messages between content.js and the service worker.

export const CHANNEL = 'GTMQA_v1';

export type CaptureVia = 'fetch' | 'xhr' | 'active';

interface Base {
  channel: typeof CHANNEL;
}

// injected -> content
export interface CaptureMsg extends Base {
  dir: 'toContent';
  type: 'capture';
  url: string;
  method: string;
  status: number;
  via: CaptureVia;
  text: string;
  ts: number;
}

export interface FetchResultMsg extends Base {
  dir: 'toContent';
  type: 'fetchResult';
  id: string;
  url: string;
  ok: boolean;
  status: number;
  text?: string;
  error?: string;
}

export interface ReadyMsg extends Base {
  dir: 'toContent';
  type: 'ready';
}

export type ToContentMsg = CaptureMsg | FetchResultMsg | ReadyMsg;

// content -> injected
export interface HelloMsg extends Base {
  dir: 'toInjected';
  type: 'hello';
}

/** Read-only GET from the user's GTM session. POST is deliberately unsupported. */
export interface FetchRequestMsg extends Base {
  dir: 'toInjected';
  type: 'fetch';
  id: string;
  url: string;
}

export type ToInjectedMsg = HelloMsg | FetchRequestMsg;

export function isChannelMsg<T extends ToContentMsg | ToInjectedMsg>(
  data: unknown,
  dir: T['dir'],
): data is T {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as Base).channel === CHANNEL &&
    (data as { dir?: unknown }).dir === dir
  );
}

// chrome.runtime messages
export type RuntimeMsg = { type: 'panel:toggle' } | { type: 'ping' } | { type: 'llm:summarize'; input: string }
  /** Review of one Tag Assistant (Preview) event; the answer is JSON (see buildPreviewPrompt). */
  | { type: 'llm:preview'; input: string };

export type LlmResponse = { ok: true; text: string; model: string } | { ok: false; error: string };
