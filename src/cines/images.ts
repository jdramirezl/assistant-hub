/**
 * Fetch an image a tool produced (cines seat maps: http://127.0.0.1:<port>/images/<id>.png,
 * valid 30 min) so the hub can upload it to Telegram. The image never enters the model context.
 *
 * Only loopback http(s) URLs, only PNG (content-type AND signature), at most 5 MB, with a
 * timeout. Anything else is refused: a tool result must not make the hub fetch the internet.
 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export class ImageRefused extends Error {}

export function assertLoopbackImageUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ImageRefused('not a URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new ImageRefused(`protocol ${u.protocol} not allowed`);
  if (!LOOPBACK.has(u.hostname)) throw new ImageRefused(`host ${u.hostname} is not loopback`);
  if (u.username || u.password) throw new ImageRefused('credentials in URL');
  return u;
}

export async function fetchLoopbackPng(raw: string, opts: { fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<Uint8Array> {
  const u = assertLoopbackImageUrl(raw);
  const res = await (opts.fetch ?? fetch)(u, { redirect: 'error', signal: AbortSignal.timeout(opts.timeoutMs ?? 5_000) });
  if (!res.ok) throw new ImageRefused(`HTTP ${res.status}`);
  const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (type !== 'image/png') throw new ImageRefused(`content-type ${type || 'missing'}`);
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > MAX_IMAGE_BYTES) throw new ImageRefused('too large');
  const reader = res.body?.getReader();
  if (!reader) throw new ImageRefused('empty body');
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_IMAGE_BYTES) {
      await reader.cancel().catch(() => {});
      throw new ImageRefused('too large');
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(size);
  let o = 0;
  for (const p of parts) {
    bytes.set(p, o);
    o += p.byteLength;
  }
  if (!PNG.every((b, i) => bytes[i] === b)) throw new ImageRefused('not a PNG');
  return bytes;
}
