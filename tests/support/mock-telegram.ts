import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Minimal fake of the Telegram Bot API, enough for @chat-adapter/telegram in polling mode.
 * Point TelegramProvider at it with `apiBaseUrl`. Queue updates with `push()` and inspect
 * what the bot sent with `calls`.
 */
export interface MockCall {
  method: string;
  body: Record<string, unknown>;
  /** What the fake Bot API answered (e.g. the sent message, with its message_id). */
  result?: unknown;
}

export interface MockFile {
  path: string;
  mime: string;
  bytes: Buffer;
}

export class MockTelegram {
  readonly calls: MockCall[] = [];
  readonly files = new Map<string, MockFile>();
  private updates: Record<string, unknown>[] = [];
  private forced: Record<string, unknown>[] = [];
  private nextUpdateId = 1;
  private nextMessageId = 1000;
  private server?: Server;
  private waiters: (() => void)[] = [];
  url = '';

  async start(): Promise<this> {
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

  /** Queue a raw update (an `update_id` is assigned unless given). Returns the update id. */
  push(update: Record<string, unknown>): number {
    const id = (update.update_id as number | undefined) ?? this.nextUpdateId++;
    this.nextUpdateId = Math.max(this.nextUpdateId, id + 1);
    this.updates.push({ ...update, update_id: id });
    this.waiters.splice(0).forEach((w) => w());
    return id;
  }

  /**
   * Deliver an update again on the next getUpdates, ignoring the confirmed offset
   * (simulates Telegram re-sending an update the bot already handled).
   */
  redeliver(update: Record<string, unknown>): void {
    this.forced.push(update);
    this.waiters.splice(0).forEach((w) => w());
  }

  addFile(fileId: string, file: MockFile): void {
    this.files.set(fileId, file);
  }

  sent(method = 'sendMessage'): MockCall[] {
    return this.calls.filter((c) => c.method === method);
  }

  /** All text the bot showed the user (sent + edited + drafts). */
  outgoingText(chatId?: number): string {
    return this.calls
      .filter((c) => ['sendMessage', 'editMessageText', 'sendMessageDraft', 'sendRichMessage'].includes(c.method))
      .filter((c) => chatId === undefined || String(c.body.chat_id) === String(chatId))
      .map((c) => {
        const rich = c.body.rich_message as { markdown?: string } | undefined;
        return String(rich?.markdown ?? c.body.text ?? '');
      })
      .join('\n');
  }

  /** Every call addressed to a chat (any method). */
  callsTo(chatId: number): MockCall[] {
    return this.calls.filter((c) => String(c.body.chat_id) === String(chatId));
  }

  async waitFor(pred: () => boolean, timeoutMs = 10_000): Promise<void> {
    const start = Date.now();
    while (!pred()) {
      if (Date.now() - start > timeoutMs) throw new Error('MockTelegram.waitFor timed out');
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  private async handle(req: IncomingMessage, res: import('node:http').ServerResponse) {
    const url = new URL(req.url ?? '/', this.url);
    const fileMatch = url.pathname.match(/^\/file\/bot[^/]+\/(.+)$/);
    if (fileMatch) {
      const file = [...this.files.values()].find((f) => f.path === fileMatch[1]);
      if (!file) return void res.writeHead(404).end();
      res.writeHead(200, { 'content-type': file.mime, 'content-length': file.bytes.length });
      return void res.end(file.bytes);
    }

    const m = url.pathname.match(/^\/bot[^/]+\/(\w+)$/);
    if (!m) return void res.writeHead(404).end();
    const method = m[1]!;
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body: Record<string, unknown>;
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      body = { raw };
    }
    const call: MockCall = { method, body };
    if (method !== 'getUpdates') this.calls.push(call);
    const result = await this.respond(method, body);
    call.result = result;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, result }));
  }

  private async respond(method: string, body: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'getMe':
        return { id: 999, is_bot: true, first_name: 'Hub', username: 'hub_test_bot' };
      case 'getWebhookInfo':
        return { url: '', pending_update_count: 0 };
      case 'getChat':
        return { id: body.chat_id, type: 'private', first_name: 'Test' };
      case 'getChatMemberCount':
        return 2;
      case 'getFile': {
        const file = this.files.get(String(body.file_id));
        return { file_id: body.file_id, file_unique_id: `u-${body.file_id}`, file_path: file?.path ?? 'missing' };
      }
      case 'getUpdates': {
        const offset = Number(body.offset ?? 0);
        // Telegram semantics: offset confirms everything below it.
        this.updates = this.updates.filter((u) => (u.update_id as number) >= offset);
        if (this.updates.length === 0 && this.forced.length === 0) {
          await new Promise<void>((r) => {
            const t = setTimeout(r, 150);
            this.waiters.push(() => {
              clearTimeout(t);
              r();
            });
          });
        }
        return [...this.forced.splice(0), ...this.updates.slice(0, Number(body.limit ?? 100))];
      }
      case 'sendMessage':
      case 'sendPhoto':
      case 'sendRichMessage':
        return {
          message_id: this.nextMessageId++,
          date: Math.floor(Date.now() / 1000),
          chat: { id: body.chat_id, type: 'private' },
          from: { id: 999, is_bot: true, first_name: 'Hub' },
          text: body.text ?? '',
        };
      case 'editMessageText':
        return {
          message_id: body.message_id,
          date: Math.floor(Date.now() / 1000),
          chat: { id: body.chat_id, type: 'private' },
          text: body.text ?? '',
        };
      default:
        return true;
    }
  }
}

let msgSeq = 1;
export function textUpdate(fromId: number, text: string) {
  return {
    message: {
      message_id: msgSeq++,
      date: Math.floor(Date.now() / 1000),
      chat: { id: fromId, type: 'private', first_name: 'U' },
      from: { id: fromId, is_bot: false, first_name: 'U', language_code: 'es' },
      text,
    },
  };
}

export function photoUpdate(fromId: number, fileId: string, caption?: string) {
  return {
    message: {
      message_id: msgSeq++,
      date: Math.floor(Date.now() / 1000),
      chat: { id: fromId, type: 'private', first_name: 'U' },
      from: { id: fromId, is_bot: false, first_name: 'U' },
      photo: [
        { file_id: `${fileId}-small`, file_unique_id: `${fileId}-s`, width: 90, height: 90, file_size: 10 },
        { file_id: fileId, file_unique_id: fileId, width: 800, height: 800, file_size: 100 },
      ],
      ...(caption ? { caption } : {}),
    },
  };
}

export function voiceUpdate(fromId: number, fileId: string) {
  return {
    message: {
      message_id: msgSeq++,
      date: Math.floor(Date.now() / 1000),
      chat: { id: fromId, type: 'private', first_name: 'U' },
      from: { id: fromId, is_bot: false, first_name: 'U' },
      voice: { file_id: fileId, file_unique_id: fileId, duration: 3, mime_type: 'audio/ogg', file_size: 100 },
    },
  };
}

/** A tap on an inline-keyboard button of a message the bot sent. */
export function callbackUpdate(fromId: number, message: { message_id: number; text?: string }, data: string) {
  return {
    callback_query: {
      id: `cb-${msgSeq++}`,
      from: { id: fromId, is_bot: false, first_name: 'U' },
      chat_instance: 'ci',
      message: {
        message_id: message.message_id,
        date: Math.floor(Date.now() / 1000),
        chat: { id: fromId, type: 'private', first_name: 'U' },
        from: { id: 999, is_bot: true, first_name: 'Hub' },
        text: message.text ?? '',
      },
      data,
    },
  };
}

/** Find the most recent inline button whose callback data contains `needle`. */
export function findButton(tg: MockTelegram, needle: string): { messageId: number; data: string } | undefined {
  for (const call of [...tg.calls].reverse()) {
    const kb = (call.body.reply_markup as { inline_keyboard?: { callback_data?: string }[][] } | undefined)?.inline_keyboard;
    const btn = kb?.flat().find((b) => b.callback_data?.includes(needle));
    if (btn) {
      const sent = (call.result as { message_id?: number } | undefined)?.message_id;
      return { messageId: Number(call.body.message_id ?? sent ?? 0), data: btn.callback_data! };
    }
  }
  return undefined;
}

/** Every inline button currently attached to messages (last write per message wins). */
export function liveButtons(tg: MockTelegram): string[] {
  const byMsg = new Map<string, string[]>();
  for (const call of tg.calls) {
    if (!['sendMessage', 'editMessageText', 'editMessageReplyMarkup'].includes(call.method)) continue;
    const id = String(call.body.message_id ?? (call.result as { message_id?: number } | undefined)?.message_id);
    const kb = (call.body.reply_markup as { inline_keyboard?: { callback_data?: string }[][] } | undefined)?.inline_keyboard;
    if (call.method === 'sendMessage' && !kb) continue;
    byMsg.set(id, (kb ?? []).flat().map((b) => b.callback_data ?? ''));
  }
  return [...byMsg.values()].flat();
}
