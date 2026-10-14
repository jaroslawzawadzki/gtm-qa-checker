// content.js side of the window.postMessage channel to injected.js (MAIN world).
import {
  CHANNEL,
  isChannelMsg,
  type CaptureMsg,
  type FetchResultMsg,
  type ToContentMsg,
  type ToInjectedMsg,
} from '../shared/messages';

const FETCH_TIMEOUT_MS = 30_000;

export class InjectedBridge {
  private readonly pending = new Map<string, (result: FetchResultMsg) => void>();
  private seq = 0;

  constructor(private readonly onCapture: (msg: CaptureMsg) => void) {
    window.addEventListener('message', this.handleMessage);
    this.send({ channel: CHANNEL, dir: 'toInjected', type: 'hello' });
  }

  /** Read-only GET executed in the page context with the user's GTM session. */
  fetch(url: string): Promise<FetchResultMsg> {
    const id = `${Date.now()}-${++this.seq}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ channel: CHANNEL, dir: 'toContent', type: 'fetchResult', id, url, ok: false, status: 0, error: 'timeout' });
      }, FETCH_TIMEOUT_MS);
      this.pending.set(id, (result) => {
        clearTimeout(timer);
        resolve(result);
      });
      this.send({ channel: CHANNEL, dir: 'toInjected', type: 'fetch', id, url });
    });
  }

  private send(msg: ToInjectedMsg): void {
    window.postMessage(msg, location.origin);
  }

  private readonly handleMessage = (event: MessageEvent): void => {
    if (event.source !== window || !isChannelMsg<ToContentMsg>(event.data, 'toContent')) return;
    const msg = event.data;
    if (msg.type === 'ready') {
      // injected.js loaded after us (or reloaded); (re)announce so it flushes its queue.
      this.send({ channel: CHANNEL, dir: 'toInjected', type: 'hello' });
    } else if (msg.type === 'capture') {
      this.onCapture(msg);
    } else if (msg.type === 'fetchResult') {
      const resolve = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      resolve?.(msg);
    }
  };
}
