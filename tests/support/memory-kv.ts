import type { NutritionKv } from '../../src/nutrition/profile.js';

/** In-memory stand-in for KvStore (get/set), for unit tests. */
export class MemoryKv implements NutritionKv {
  readonly data = new Map<string, unknown>();
  async get<T = unknown>(key: string): Promise<T | null> {
    return (this.data.has(key) ? structuredClone(this.data.get(key)) : null) as T | null;
  }
  async set(key: string, value: unknown): Promise<void> {
    this.data.set(key, structuredClone(value));
  }
}
