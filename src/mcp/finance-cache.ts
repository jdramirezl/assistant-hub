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

export interface CachedAccount {
  id: string;
  name: string;
  currency?: string;
  balance?: number;
}
export interface CachedPocket {
  id: string;
  accountId: string;
  name: string;
  type?: string;
  balance?: number;
}

export class FinanceDirectory {
  private text?: string;
  private at = -Infinity;
  private inflight?: Promise<string | undefined>;
  /** pocketId → accountId, from the last successful load. */
  private owner = new Map<string, string>();
  private accountList: CachedAccount[] = [];
  private pocketList: CachedPocket[] = [];

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

  /** Accounts and pockets (with balances) from a FRESH read; undefined when finance cannot be listed. */
  async snapshot(opts: { fresh?: boolean } = {}): Promise<{ accounts: CachedAccount[]; pockets: CachedPocket[] } | undefined> {
    if (opts.fresh) this.invalidate();
    await this.prompt().catch(() => '');
    return this.text === undefined ? undefined : { accounts: this.accountList, pockets: this.pocketList };
  }

  private pocketLines(accountId?: string): string {
    return this.pocketList
      .filter((p) => !accountId || p.accountId === accountId)
      .map((p) => `- ${this.accountList.find((a) => a.id === p.accountId)?.name ?? '?'} / ${p.name} id=${p.id} accountId=${p.accountId}${p.type === 'fixed' ? ' (fixed)' : ''}`)
      .join('\n');
  }

  /**
   * Account → pocket → optional sub-pocket, checked against the cache BEFORE the server sees it
   * (the model confuses the levels). A pocketId that is really the account id, with the real
   * pocket in subPocketId, is remapped; a known pocket gets its own account; a pocket id sent as
   * subPocketId is dropped (subPocketId is only for fixed-expense sub-pockets, which are not
   * pockets). Anything else unknown → an error for the model with the valid pocket list.
   */
  async repairPocket(args: Rec): Promise<{ args: Rec; fixed?: string } | { error: string }> {
    if (typeof args.pocketId !== 'string') return { args };
    if (this.text === undefined) await this.prompt().catch(() => '');
    if (this.text === undefined) return { args }; // no cache: the server validates
    const pocket = (id: unknown) => this.pocketList.find((p) => p.id === id);
    const account = (id: unknown) => this.accountList.find((a) => a.id === id);
    let p = pocket(args.pocketId);
    if (!p && !account(args.pocketId)) {
      this.invalidate(); // maybe a new pocket: refresh once
      await this.prompt().catch(() => '');
      p = pocket(args.pocketId);
    }
    const out: Rec = { ...args };
    const fixes: string[] = [];
    if (!p) {
      const acc = account(args.pocketId);
      const sub = pocket(args.subPocketId);
      if (acc && sub && sub.accountId === acc.id) {
        out.pocketId = sub.id;
        delete out.subPocketId;
        fixes.push(`pocketId was the account id of ${acc.name}; used the pocket ${sub.name} from subPocketId`);
        p = sub;
      } else if (acc) {
        return { error: `pocketId ${String(args.pocketId)} is the ACCOUNT id of ${acc.name}, not a pocket id. Hierarchy: account → pocket → optional sub-pocket (fixed expenses only). Use one of its pockets as pocketId (name id accountId):\n${this.pocketLines(acc.id)}` };
      } else {
        return { error: `pocketId ${String(args.pocketId)} is not a pocket id. Copy pocketId from this list (name id accountId), never an account id:\n${this.pocketLines()}` };
      }
    }
    if (out.accountId !== p.accountId) {
      if (out.accountId) fixes.push(`accountId ${String(out.accountId)} → ${p.accountId} (the pocket's own account)`);
      else fixes.push('accountId filled from the pocket');
      out.accountId = p.accountId;
    }
    if (out.subPocketId !== undefined && out.subPocketId !== null && pocket(out.subPocketId)) {
      delete out.subPocketId;
      fixes.push('subPocketId was a pocket id (sub-pockets are only for fixed expenses); dropped');
    }
    return fixes.length ? { args: out, fixed: fixes.join('; ') } : { args: out };
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
    const lines = [`Finance accounts and pockets (as of ${time}; use these ids directly, no need to list them; a movement's pocketId is a POCKET id below, never the account id; balances may be stale after writes elsewhere):`];
    for (const a of accounts) {
      lines.push(`- ${a.name} (${a.currency}${a.type ? `, ${a.type}` : ''}) id=${a.id}${a.balance !== undefined ? ` balance=${a.balance}` : ''}`);
      for (const p of pockets.filter((x) => x.accountId === a.id)) lines.push(`  - pocket ${p.name} id=${p.id} accountId=${a.id}${p.balance !== undefined ? ` balance=${p.balance}` : ''}`);
    }
    this.accountList = accounts.filter((a) => typeof a.id === 'string').map((a) => ({ id: a.id as string, name: String(a.name ?? a.id), currency: a.currency as string | undefined, balance: typeof a.balance === 'number' ? a.balance : undefined }));
    this.pocketList = pockets
      .filter((p) => typeof p.id === 'string' && typeof p.accountId === 'string')
      .map((p) => ({ id: p.id as string, accountId: p.accountId as string, name: String(p.name ?? p.id), type: p.type as string | undefined, balance: typeof p.balance === 'number' ? p.balance : undefined }));
    this.owner = new Map(pockets.filter((p) => typeof p.id === 'string' && typeof p.accountId === 'string').map((p) => [p.id as string, p.accountId as string]));
    this.text = lines.join('\n');
    this.at = now;
    return this.text;
  }
}
