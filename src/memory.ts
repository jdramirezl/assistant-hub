import { mkdirSync } from 'node:fs';
import { createClient, type Client } from '@libsql/client';
import { LibSQLStore } from '@mastra/libsql';
import { Memory } from '@mastra/memory';
import type { HubConfig } from './config.js';
import { KvStore } from './kv.js';

/** Resource-scoped working memory: durable facts about the user, shared across all chats. */
export const WORKING_MEMORY_TEMPLATE = `# User preferences
- Name:
- Language preference:
- Default currency: (e.g. COP)
- Pockets / accounts: (e.g. Nequi, Bancolombia, cash)
- Recurring merchants or categories:
- Fitness goals: (calories, macros)
- Other notes:
`;

/** One LibSQL client per data dir; creates the dir (0700) if missing. */
export function createDbClient(config: Pick<HubConfig, 'dataDir' | 'dbPath'>): Client {
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  return createClient({ url: `file:${config.dbPath}` });
}

/** Mastra storage at an absolute path. Pass `client` to share the connection with KvStore. */
export function createStorage(config: Pick<HubConfig, 'dataDir' | 'dbPath'>, client?: Client): LibSQLStore {
  const c = client ?? createDbClient(config);
  return new LibSQLStore({ id: 'assistant-hub', client: c as never });
}

export function createKv(client: Client): KvStore {
  return new KvStore(client);
}

export function createMemory(storage: LibSQLStore): Memory {
  return new Memory({
    storage,
    options: {
      lastMessages: 20,
      semanticRecall: false, // no embedder/vector store needed; keeps cost at zero
      workingMemory: { enabled: true, scope: 'resource', template: WORKING_MEMORY_TEMPLATE },
    },
  });
}
