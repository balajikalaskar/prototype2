import { randomUUID } from 'node:crypto';
import { CrawlError } from '../crawl-error.js';

interface Closable { close(): Promise<void> }
interface Entry<T> { key: string; value: Promise<T>; busy: boolean; touched: number }

/** Anonymous per-origin sessions. Leases are exclusive; busy sessions are never evicted. */
export class SessionStore<T extends Closable> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly timer: NodeJS.Timeout;
  private closing = false;

  constructor(private readonly max: number, private readonly ttlMs: number) {
    this.timer = setInterval(() => { void this.expire(); }, Math.min(ttlMs, 30000));
    this.timer.unref();
  }

  private async remove(id: string, entry: Entry<T>): Promise<void> {
    this.entries.delete(id);
    await entry.value.then((value) => value.close()).catch(() => {});
  }

  private async expire(): Promise<void> {
    const now = Date.now();
    await Promise.all([...this.entries].filter(([, entry]) => !entry.busy && now - entry.touched >= this.ttlMs)
      .map(([id, entry]) => this.remove(id, entry)));
  }

  async acquire(key: string, create: () => Promise<T>) {
    if (this.closing) throw new CrawlError('SHUTTING_DOWN', 'The session store is shutting down.');
    // Reserve synchronously before the first await to prevent races with another acquisition.
    const existing = [...this.entries].find(([, entry]) => entry.key === key && !entry.busy && Date.now() - entry.touched < this.ttlMs);
    let id: string;
    let entry: Entry<T>;
    if (existing) {
      [id, entry] = existing;
      entry.busy = true;
    } else {
      if (this.entries.size >= this.max) {
        const idle = [...this.entries].filter(([, value]) => !value.busy).sort((a, b) => a[1].touched - b[1].touched)[0];
        if (!idle) throw new CrawlError('CAPACITY_EXHAUSTED', 'All anti-bot sessions are busy.');
        void this.remove(...idle);
      }
      id = randomUUID();
      entry = { key, busy: true, touched: Date.now(), value: Promise.resolve().then(create) };
      this.entries.set(id, entry);
    }
    try {
      const value = await entry.value;
      return { value, release: async (discard = false) => {
        entry.busy = false;
        entry.touched = Date.now();
        if (discard) await this.remove(id, entry);
      } };
    } catch (error) { this.entries.delete(id); throw error; }
  }

  async close(): Promise<void> {
    this.closing = true;
    clearInterval(this.timer);
    await Promise.all([...this.entries].map(([id, entry]) => this.remove(id, entry)));
  }
}
