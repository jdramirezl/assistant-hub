/**
 * Hub-side cache of the user's accounts and pockets, put into the prompt (finance requests
 * only) so an expense needs no list call. Refreshed on a TTL and after every finance write.
 */
type Rec = Record<string, unknown>;
export interface ListToolbox {
  execute(name: string, args: Rec, opts?: { raw?: boolean }): Promise<unknown>;
}

export const FINANCE_CACHE_TTL_MS = 10 * 60_000;
export const FINANCE_WRITES = new Set(['finance_create_movement', 'finance_create_transfer', 'finance_update_movement', 'finance_delete_movement', 'finance_apply_pending_movement', 'finance_mark_reminder_paid']);

const listOf = (v: unknown): Rec[] | undefined => {
  if (Array.isArray(v)) return v as Rec[];
  const r = (v as Rec | undefined)?.result;
  return Array.isArray(r) ? (r as Rec[]) : undefined;
};

export class FinanceDirectory {
  private text?: string;
  private at = -Infinity;
  private inflight?: Promise<string | undefined>;
  /** pocketId → accountId, from the last successful load. */
  private owner = new Map<string, string>();

  constructor(
    private readonly toolbox: ListToolbox,
    private readonly opts: { now?: () => number; timezone?: string; ttlMs?: number; available?: () => boolean | Promise<boolean> } = {},
  ) {}

  invalidate(): void {
    this.text = undefined;
    this.at = -Infinity;
  }

  /** Prompt block (or '' when finance is unavailable). */
  async prompt(): Promise<string> {
    if (this.opts.available && !(await this.opts.available())) return '';
    const now = (this.opts.now ?? Date.now)();
    if (this.text !== undefined && now - this.at < (this.opts.ttlMs ?? FINANCE_CACHE_TTL_MS)) return this.text;
    this.inflight ??= this.load(now).finally(() => (this.inflight = undefined));
    return (await this.inflight) ?? '';
  }

  /** The account a pocket belongs to (loads the cache if needed); undefined if unknown. */
  async accountOf(pocketId: string): Promise<string | undefined> {
    if (!this.owner.has(pocketId)) {
      if (this.text === undefined) await this.prompt().catch(() => '');
      if (!this.owner.has(pocketId)) {
        this.invalidate(); // maybe a new pocket: refresh once
        await this.prompt().catch(() => '');
      }
    }
    return this.owner.get(pocketId);
  }

  /**
   * finance_create_movement with a pocketId but no accountId (the model often forgets it):
   * fill the pocket's owning account from the cache, deterministically, before validation.
   */
  async fillAccount(args: Rec): Promise<Rec> {
    if (args.accountId || typeof args.pocketId !== 'string') return args;
    const accountId = await this.accountOf(args.pocketId);
    return accountId ? { ...args, accountId } : args;
  }

  private async load(now: number): Promise<string | undefined> {
    const [acc, poc] = await Promise.all([
      this.toolbox.execute('finance_list_accounts', {}, { raw: true }),
      this.toolbox.execute('finance_list_pockets', {}, { raw: true }),
    ]);
    const accounts = listOf(acc);
    const pockets = listOf(poc);
    if (!accounts || !pockets) return undefined; // error: no cache, the model can still list
    const time = new Intl.DateTimeFormat('en-GB', { timeZone: this.opts.timezone ?? 'America/Bogota', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
    const lines = [`Finance accounts and pockets (as of ${time}; use these ids directly, no need to list them; balances may be stale after writes elsewhere):`];
    for (const a of accounts) {
      lines.push(`- ${a.name} (${a.currency}${a.type ? `, ${a.type}` : ''}) id=${a.id}${a.balance !== undefined ? ` balance=${a.balance}` : ''}`);
      for (const p of pockets.filter((x) => x.accountId === a.id)) lines.push(`  - pocket ${p.name} id=${p.id} accountId=${a.id}${p.balance !== undefined ? ` balance=${p.balance}` : ''}`);
    }
    this.owner = new Map(pockets.filter((p) => typeof p.id === 'string' && typeof p.accountId === 'string').map((p) => [p.id as string, p.accountId as string]));
    this.text = lines.join('\n');
    this.at = now;
    return this.text;
  }
}
