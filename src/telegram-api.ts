/** Minimal Telegram Bot API client for messages the hub sends on its own (plans, notices). */
export interface InlineButton {
  text: string;
  callback_data: string;
}

export class TelegramApi {
  constructor(
    private readonly token: string,
    private readonly baseUrl = 'https://api.telegram.org',
    private readonly doFetch: typeof fetch = fetch,
  ) {}

  async call<T = unknown>(method: string, body: Record<string, unknown>): Promise<T> {
    const res = await this.doFetch(`${this.baseUrl}/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string };
    if (!res.ok || !data.ok) throw new Error(`Telegram ${method} failed: ${data.description ?? `HTTP ${res.status}`}`);
    return data.result as T;
  }

  async send(chatId: string, text: string, keyboard?: InlineButton[][]): Promise<number> {
    const msg = await this.call<{ message_id: number }>('sendMessage', {
      chat_id: chatId,
      text,
      ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
    });
    return msg.message_id;
  }

  /** Replace a message's text and remove its buttons. */
  async editFinal(chatId: string, messageId: number, text: string): Promise<void> {
    await this.call('editMessageText', { chat_id: chatId, message_id: messageId, text, reply_markup: { inline_keyboard: [] } });
  }

  /** Upload a photo (multipart; Telegram fetches nothing from our side). */
  async sendPhoto(chatId: string, bytes: Uint8Array, opts: { caption?: string; filename?: string } = {}): Promise<number> {
    const form = new FormData();
    form.set('chat_id', chatId);
    if (opts.caption) form.set('caption', opts.caption);
    form.set('photo', new Blob([bytes], { type: 'image/png' }), opts.filename ?? 'image.png');
    const res = await this.doFetch(`${this.baseUrl}/bot${this.token}/sendPhoto`, { method: 'POST', body: form, signal: AbortSignal.timeout(30_000) });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: { message_id: number }; description?: string };
    if (!res.ok || !data.ok) throw new Error(`Telegram sendPhoto failed: ${data.description ?? `HTTP ${res.status}`}`);
    return data.result!.message_id;
  }

  /** Status messages (HTML parse mode): send, edit in place, delete. */
  async sendHtml(chatId: string, html: string): Promise<number> {
    const msg = await this.call<{ message_id: number }>('sendMessage', { chat_id: chatId, text: html, parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
    return msg.message_id;
  }

  async editHtml(chatId: string, messageId: number, html: string): Promise<void> {
    await this.call('editMessageText', { chat_id: chatId, message_id: messageId, text: html, parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
  }

  async remove(chatId: string, messageId: number): Promise<void> {
    await this.call('deleteMessage', { chat_id: chatId, message_id: messageId });
  }

  /** Replace a message's text; buttons replaced by `keyboard` (none when omitted). */
  async editKeyboard(chatId: string, messageId: number, text: string, keyboard?: InlineButton[][]): Promise<void> {
    await this.call('editMessageText', { chat_id: chatId, message_id: messageId, text, reply_markup: { inline_keyboard: keyboard ?? [] } });
  }
}
