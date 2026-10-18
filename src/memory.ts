import { mkdirSync } from 'node:fs';
import { LibSQLStore } from '@mastra/libsql';
import { Memory } from '@mastra/memory';
import type { HubConfig } from './config.js';

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

/** LibSQL storage at an absolute path; creates the data dir (0700) if missing. */
export function createStorage(config: Pick<HubConfig, 'dataDir' | 'dbPath'>): LibSQLStore {
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  return new LibSQLStore({ id: 'assistant-hub', url: `file:${config.dbPath}` });
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
