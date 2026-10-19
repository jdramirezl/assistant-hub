import { mkdirSync } from 'node:fs';
import { createClient, type Client } from '@libsql/client';
import { LibSQLStore } from '@mastra/libsql';
import { Memory } from '@mastra/memory';
import type { HubConfig } from './config.js';
import { KvStore } from './kv.js';
import type { ProcessInputArgs, Processor } from '@mastra/core/processors';

/** Resource-scoped working memory: durable facts about the user, shared across all chats. */
export const WORKING_MEMORY_TEMPLATE = `# User preferences
- Name:
- Language:
- Default currency / accounts:
- Fitness goals:
- Other:
`;

/**
 * Short, stable working-memory instruction. Mastra's default (~700 tokens) repeats the template
 * and tells the model to call updateWorkingMemory in every response, which costs an extra model
 * call per message and conflicts with "only durable preferences".
 */
export function workingMemoryInstruction(data: string | null): string {
  return [
    '## Working memory (durable user preferences)',
    'Call updateWorkingMemory ONLY when the user states a new or changed durable preference (name, language, default currency or accounts, fitness goals). Send the whole document. Never store transactions, meals or other records, and never call it just to confirm.',
    '<working_memory>',
    (data ?? WORKING_MEMORY_TEMPLATE).trim(),
    '</working_memory>',
  ].join('\n');
}

/**
 * Replaces Mastra's built-in "working-memory" input processor (same id, so Mastra skips its
 * own) with one that injects the short instruction above. The updateWorkingMemory tool and
 * storage are unchanged.
 */
export class WorkingMemoryPrompt implements Processor<'working-memory'> {
  readonly id = 'working-memory' as const;
  readonly name = 'Working memory (short instruction)';
  constructor(private readonly memory: Memory) {}

  async processInput({ messageList, requestContext }: ProcessInputArgs) {
    const ctx = requestContext?.get('MastraMemory') as { thread?: { id?: string }; resourceId?: string } | undefined;
    const threadId = ctx?.thread?.id;
    const resourceId = ctx?.resourceId;
    if (!threadId && !resourceId) return messageList;
    const data = await this.memory.getWorkingMemory({ threadId: threadId ?? resourceId!, resourceId }).catch(() => null);
    messageList.addSystem(workingMemoryInstruction(data), 'memory');
    return messageList;
  }
}

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
      lastMessages: 15,
      semanticRecall: false, // no embedder/vector store needed; keeps cost at zero
      workingMemory: { enabled: true, scope: 'resource', template: WORKING_MEMORY_TEMPLATE },
    },
  });
}
