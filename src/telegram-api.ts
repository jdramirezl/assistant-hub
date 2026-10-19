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
}
