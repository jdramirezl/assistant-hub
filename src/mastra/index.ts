// Entry point used by `mastra dev` and `mastra build`.
import { loadConfig } from '../config.js';
import { createHub } from '../hub.js';

process.env.MASTRA_TELEMETRY_DISABLED ??= '1';

export const mastra = createHub(loadConfig());
