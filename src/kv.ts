import type { Client } from '@libsql/client';

/**
 * Tiny persistent key/value table in the hub's LibSQL file. Used for channel dedup and
 * polling checkpoints, budget counters and scheduler bookkeeping.
 */
export class KvStore {
  private ready?: Promise<void>;

  constructor(
    private readonly client: Client,
    private readonly now: () => number = Date.now,
  ) {}

  private init(): Promise<void> {
    this.ready ??= this.client
      .batch(
        [
          'CREATE TABLE IF NOT EXISTS hub_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER)',
          'CREATE INDEX IF NOT EXISTS hub_kv_expires ON hub_kv (expires_at)',
        ],
        'write',
      )
      .then(() => undefined);
    return this.ready;
  }

  private expiry(ttlMs?: number): number | null {
    return ttlMs && ttlMs > 0 ? this.now() + ttlMs : null;
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    await this.init();
    const rs = await this.client.execute({
      sql: 'SELECT value FROM hub_kv WHERE key = ? AND (expires_at IS NULL OR expires_at > ?)',
      args: [key, this.now()],
    });
    const row = rs.rows[0];
    return row ? (JSON.parse(String(row.value)) as T) : null;
  }

  async set(key: string, value: unknown, ttlMs?: number): Promise<void> {
    await this.init();
    await this.client.execute({
      sql: 'INSERT INTO hub_kv (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at',
      args: [key, JSON.stringify(value), this.expiry(ttlMs)],
    });
  }

  /** Atomic claim: true when this call created (or replaced an expired) key. */
  async setIfNotExists(key: string, value: unknown, ttlMs?: number): Promise<boolean> {
    await this.init();
    const rs = await this.client.execute({
      sql: `INSERT INTO hub_kv (key, value, expires_at) VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at
            WHERE hub_kv.expires_at IS NOT NULL AND hub_kv.expires_at <= ?`,
      args: [key, JSON.stringify(value), this.expiry(ttlMs), this.now()],
    });
    return rs.rowsAffected > 0;
  }

  /** Atomic numeric increment (missing/expired key counts as 0). Returns the new value. */
  async incr(key: string, by: number, ttlMs?: number): Promise<number> {
    await this.init();
    const rs = await this.client.execute({
      sql: `INSERT INTO hub_kv (key, value, expires_at) VALUES (?, json(?), ?)
            ON CONFLICT(key) DO UPDATE SET
              value = CASE WHEN hub_kv.expires_at IS NOT NULL AND hub_kv.expires_at <= ?
                           THEN json(?) ELSE json(CAST(hub_kv.value AS REAL) + ?) END,
              expires_at = COALESCE(hub_kv.expires_at, excluded.expires_at)
            RETURNING value`,
      args: [key, String(by), this.expiry(ttlMs), this.now(), String(by), by],
    });
    return Number(JSON.parse(String(rs.rows[0]!.value)));
  }

  async delete(key: string): Promise<void> {
    await this.init();
    await this.client.execute({ sql: 'DELETE FROM hub_kv WHERE key = ?', args: [key] });
  }

  async purgeExpired(): Promise<void> {
    await this.init();
    await this.client.execute({ sql: 'DELETE FROM hub_kv WHERE expires_at IS NOT NULL AND expires_at <= ?', args: [this.now()] });
  }
}
