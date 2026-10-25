/**
 * Module text kept in memory for 60 s per (controller, daemon start, task,
 * module), so paging through a module, reading around a line or slicing a
 * routine costs the controller nothing after the first read. An entry is
 * dropped when the snapshot's module list for its task changes. At most 8 MiB
 * in all, oldest out first. Nothing is written to disk.
 */

export const MODULE_CACHE_MS = 60_000;
export const MODULE_CACHE_MAX_BYTES = 8 * 1024 * 1024;

export interface CachedModule {
  text: string;
  kind: string | null;
  changeCount: number | null;
  readAt: number;
}

interface Entry extends CachedModule {
  key: string;
  listSig: string;
  bytes: number;
}

export class ModuleCache {
  private readonly entries = new Map<string, Entry>();
  private bytes = 0;

  constructor(private readonly now: () => number = Date.now) {}

  static key(controller: string, startedAt: string, task: string, module: string): string {
    return JSON.stringify([controller, startedAt, task.toLowerCase(), module.toLowerCase()]);
  }

  /** The signature of a task's module list, to notice a change. */
  static listSig(modules: readonly string[]): string {
    return JSON.stringify(modules);
  }

  get(key: string, listSig: string): CachedModule | null {
    const e = this.entries.get(key);
    if (!e) { return null; }
    if (this.now() - e.readAt >= MODULE_CACHE_MS || e.listSig !== listSig) {
      this.drop(key);
      return null;
    }
    return { text: e.text, kind: e.kind, changeCount: e.changeCount, readAt: e.readAt };
  }

  set(key: string, listSig: string, value: CachedModule): void {
    this.drop(key);
    const bytes = value.text.length * 2;
    if (bytes > MODULE_CACHE_MAX_BYTES) { return; }
    // Expired entries first, then the oldest, until the new one fits.
    for (const [k, e] of this.entries) {
      if (this.now() - e.readAt >= MODULE_CACHE_MS) { this.drop(k); }
    }
    while (this.bytes + bytes > MODULE_CACHE_MAX_BYTES && this.entries.size > 0) {
      const oldest = this.entries.keys().next().value as string;
      this.drop(oldest);
    }
    this.entries.set(key, { ...value, key, listSig, bytes });
    this.bytes += bytes;
  }

  private drop(key: string): void {
    const e = this.entries.get(key);
    if (!e) { return; }
    this.bytes -= e.bytes;
    this.entries.delete(key);
  }

  get size(): number { return this.entries.size; }
  get totalBytes(): number { return this.bytes; }
}
