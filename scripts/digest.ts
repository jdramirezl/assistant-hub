// Run the weekly digest now: `npm run digest` (always sends; marks this week as done).
// Safe to run while the service is up: delivery uses a plain sendMessage, not the long-poll.
import { loadConfig } from '../src/config.js';
import { createHub } from '../src/hub.js';

process.env.MASTRA_TELEMETRY_DISABLED ??= '1';

const hub = createHub(loadConfig(), { telegram: { log: (m) => console.log(m) } });
try {
  const res = await hub.runDigest({ trigger: 'manual', force: true });
  console.log(res ? `digest ${res.status} for week ending ${res.period}` : 'digest failed (see log above)');
  process.exitCode = res ? 0 : 1;
} finally {
  await hub.stop();
}
