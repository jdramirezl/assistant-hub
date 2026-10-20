/**
 * A loopback stand-in for the Telegram Bot API: the debug hub talks to it exactly as it talks
 * to Telegram (same channel, router, guards, status layer, cards, photos), and every call is
 * captured instead of being sent anywhere. Photos are written to files.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type Rec = Record<string, unknown>;
export interface SinkCall {
  method: string;
  body: Rec;
  result?: unknown;
  at: number;
}
export interface SinkFile {
  path: string;
  mime: string;
  bytes: Buffer;
}

export class TelegramSink {
  readonly calls: SinkCall[] = [];
  private files = new Map<string, SinkFile>();
  private updates: Rec[] = [];
  private nextUpdate = 1;
  private nextMessage = 1;
  // unique across restarts: the hub dedups handled message ids in its database
  private msgSeq = Math.floor(Date.now() / 100) % 2_000_000_000;
  private server?: Server;
  private waiters: (() => void)[] = [];
  lastActivity = Date.now();
  url = '';

  constructor(
    private readonly photoDir: string,
    readonly userId: number,
  ) {}

  async start(): Promise<this> {
    mkdirSync(this.photoDir, { recursive: true, mode: 0o700 });
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }
  async stop(): Promise<void> {
    this.waiters.splice(0).forEach((w) => w());
    this.server?.closeAllConnections();
    await new Promise<void>((r) => this.server?.close(() => r()) ?? r());
  }

  private push(update: Rec): void {
    this.updates.push({ ...update, update_id: this.nextUpdate++ });
    this.lastActivity = Date.now();
    this.waiters.splice(0).forEach((w) => w());
  }
  private base(extra: Rec) {
    const id = this.userId;
    return { message: { message_id: this.msgSeq++, date: Math.floor(Date.now() / 1000), chat: { id, type: 'private', first_name: 'Debug' }, from: { id, is_bot: false, first_name: 'Debug', language_code: 'es' }, ...extra } };
  }
  text(text: string): void {
    this.push(this.base({ text, ...(/^\/\w+/.test(text) ? { entities: [{ type: 'bot_command', offset: 0, length: text.match(/^\/\w+/)![0].length }] } : {}) }));
  }
  voice(bytes: Buffer, mime: string): void {
    const id = `voice-${this.msgSeq}`;
    this.files.set(id, { path: `files/${id}`, mime, bytes });
    this.push(this.base({ voice: { file_id: id, file_unique_id: id, duration: 5, mime_type: mime, file_size: bytes.length } }));
  }
  photo(bytes: Buffer, mime: string, caption?: string): void {
    const id = `photo-${this.msgSeq}`;
    this.files.set(id, { path: `files/${id}`, mime, bytes });
    this.push(this.base({ photo: [{ file_id: id, file_unique_id: id, width: 800, height: 800, file_size: bytes.length }], ...(caption ? { caption } : {}) }));
  }
  /** Press an inline button: `needle` matches its callback data or its label. */
  press(needle: string): { data: string; label: string } | undefined {
    for (const call of [...this.calls].reverse()) {
      const kb = (call.body.reply_markup as { inline_keyboard?: { callback_data?: string; text?: string }[][] } | undefined)?.inline_keyboard;
      const btn = kb?.flat().find((b) => b.callback_data && (b.callback_data.includes(needle) || (b.text ?? '').toLowerCase().includes(needle.toLowerCase())));
      if (!btn) continue;
      const mid = Number(call.body.message_id ?? (call.result as { message_id?: number } | undefined)?.message_id ?? 0);
      this.push({
        callback_query: {
          id: `cb-${this.msgSeq++}`,
          from: { id: this.userId, is_bot: false, first_name: 'Debug' },
          chat_instance: 'debug',
          message: { message_id: mid, date: Math.floor(Date.now() / 1000), chat: { id: this.userId, type: 'private' }, from: { id: 999, is_bot: true, first_name: 'Hub' }, text: String(call.body.text ?? '') },
          data: btn.callback_data,
        },
      });
      return { data: btn.callback_data!, label: btn.text ?? '' };
    }
    return undefined;
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', this.url);
    const file = url.pathname.match(/^\/file\/bot[^/]+\/(.+)$/);
    if (file) {
      const f = [...this.files.values()].find((x) => x.path === file[1]);
      if (!f) return void res.writeHead(404).end();
      res.writeHead(200, { 'content-type': f.mime, 'content-length': f.bytes.length });
      return void res.end(f.bytes);
    }
    const m = url.pathname.match(/^\/bot[^/]+\/(\w+)$/);
    if (!m) return void res.writeHead(404).end();
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const buf = Buffer.concat(chunks);
    const ct = String(req.headers['content-type'] ?? '');
    let body: Rec = {};
    if (ct.startsWith('multipart/form-data')) {
      const form = await new Response(buf, { headers: { 'content-type': ct } }).formData();
      for (const [k, v] of form.entries()) {
        if (typeof v === 'string') body[k] = v;
        else {
          const p = join(this.photoDir, `${Date.now()}-${this.nextMessage}.png`);
          writeFileSync(p, Buffer.from(await v.arrayBuffer()), { mode: 0o600 });
          body[k] = { file: p };
        }
      }
    } else {
      try {
        body = buf.length ? (JSON.parse(buf.toString('utf8')) as Rec) : {};
      } catch {
        body = {};
      }
    }
    const method = m[1]!;
    const result = await this.respond(method, body);
    if (method !== 'getUpdates') {
      this.calls.push({ method, body, result, at: Date.now() });
      this.lastActivity = Date.now();
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, result }));
  }

  private async respond(method: string, body: Rec): Promise<unknown> {
    const msg = () => ({ message_id: this.nextMessage++, date: Math.floor(Date.now() / 1000), chat: { id: body.chat_id, type: 'private' }, from: { id: 999, is_bot: true, first_name: 'Hub' }, text: body.text ?? '' });
    switch (method) {
      case 'getMe':
        return { id: 999, is_bot: true, first_name: 'Hub', username: 'hub_debug_bot' };
      case 'getWebhookInfo':
        return { url: '', pending_update_count: 0 };
      case 'getChat':
        return { id: body.chat_id, type: 'private', first_name: 'Debug' };
      case 'getFile': {
        const f = this.files.get(String(body.file_id));
        return { file_id: body.file_id, file_unique_id: `u-${body.file_id}`, file_path: f?.path ?? 'missing' };
      }
      case 'getUpdates': {
        const offset = Number(body.offset ?? 0);
        this.updates = this.updates.filter((u) => (u.update_id as number) >= offset);
        if (!this.updates.length) {
          await new Promise<void>((r) => {
            const t = setTimeout(r, 300);
            this.waiters.push(() => (clearTimeout(t), r()));
          });
        }
        return this.updates.slice(0, 100);
      }
      case 'sendMessage':
      case 'sendPhoto':
      case 'sendRichMessage':
        return msg();
      case 'editMessageText':
        return { message_id: body.message_id, date: Math.floor(Date.now() / 1000), chat: { id: body.chat_id, type: 'private' }, text: body.text ?? '' };
      default:
        return true;
    }
  }
}
