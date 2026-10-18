// Entry point used by `mastra dev` and `mastra build`.
import { loadConfig } from '../config.js';
import { createHub } from '../hub.js';

process.env.MASTRA_TELEMETRY_DISABLED ??= '1';

const hub = createHub(loadConfig());

// Connect channels in the background so the server comes up even if Telegram is unreachable.
void hub.start({ ops: process.env.NODE_ENV === 'production' });

export const mastra = hub.mastra;
