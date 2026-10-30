export function cleanSenderName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const name = Array.from(value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/gu, ' ').trim()).slice(0, 128).join('');
  return name || undefined;
}

export const senderLabel = (id: number, name?: string) => cleanSenderName(name) ?? `UID ${id}`;
type Sender = { senderId: number; senderName?: string };
type Lookup = { name: string; found: boolean };

/** Display data only. Cache is owned by one bridge, never used for identity or routing. */
export class SenderNames {
  private cache = new Map<number, { name: string; expiresAt: number }>();
  private pending = new Map<number, Promise<string>>();
  private request: (uid: number, signal: AbortSignal) => Promise<string>;
  private timeoutMs: number;
  private now: () => number;
  constructor(request: SenderNames['request'], options: { timeoutMs?: number; now?: () => number } = {}) {
    this.request = request; this.timeoutMs = options.timeoutMs ?? 1500; this.now = options.now ?? Date.now;
  }
  private cached(id: number): string | undefined {
    const entry = this.cache.get(id);
    if (entry && entry.expiresAt > this.now()) return entry.name;
    this.cache.delete(id); return undefined;
  }
  private remember(id: number, name: string, found: boolean) {
    this.cache.delete(id);
    this.cache.set(id, { name, expiresAt: this.now() + (found ? 300_000 : 30_000) });
    if (this.cache.size > 512) this.cache.delete(this.cache.keys().next().value!);
  }
  private lookup(id: number, signal: AbortSignal): Promise<string> {
    const cached = this.cached(id); if (cached !== undefined) return Promise.resolve(cached);
    const existing = this.pending.get(id); if (existing) return existing;
    const fallback: Lookup = { name: senderLabel(id), found: false };
    let abort!: () => void;
    const cancelled = new Promise<Lookup>(resolve => {
      abort = () => resolve(fallback);
      if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
    });
    const requested = Promise.resolve().then(() => this.request(id, signal)).then(value => {
      const name = cleanSenderName(value); return name ? { name, found: true } : fallback;
    }, () => fallback);
    const operation = Promise.race([requested, cancelled]).then(result => {
      this.remember(id, result.name, result.found); return result.name;
    }).finally(() => { signal.removeEventListener('abort', abort); this.pending.delete(id); });
    this.pending.set(id, operation); return operation;
  }
  private wait(operation: Promise<string>, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise(resolve => {
      const done = () => { signal.removeEventListener('abort', done); resolve(); };
      signal.addEventListener('abort', done, { once: true });
      operation.then(done, done);
    });
  }
  async apply(messages: Sender[], signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const ids = [...new Set(messages.map(message => message.senderId))]; if (!ids.length) return;
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, ids.length) }, async () => {
      while (next < ids.length) {
        const id = ids[next++];
        if (this.cached(id) !== undefined) continue;
        if (deadline.aborted) break;
        await this.wait(this.lookup(id, deadline), deadline);
      }
    }));
    signal.throwIfAborted();
    for (const message of messages) {
      const name = this.cached(message.senderId);
      message.senderName = name ?? senderLabel(message.senderId);
      if (name === undefined) this.remember(message.senderId, message.senderName, false);
    }
  }
}
