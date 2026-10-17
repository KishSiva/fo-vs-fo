/**
 * pnpm cache:check [--env .env.agent1]
 * Sends the orchestrator's cached prefix twice with max_tokens: 0 and prints the
 * usage fields. The second call should show cache_read_input_tokens > 0.
 */
import { config } from 'dotenv';
import pino from 'pino';
import { openDb, deals, mandates, now } from '@proxydeal/core';
import { cacheTtl, modelLeakCheck, cacheStats } from '@proxydeal/llm';
import { prewarm } from '../apps/proxy/src/orchestrator.js';
import { Store } from '../apps/proxy/src/store.js';
import { loadConfig } from '../apps/proxy/src/config.js';

const i = process.argv.indexOf('--env');
config({ path: i > -1 ? process.argv[i + 1] : '.env.agent1', override: true });
const cfg = { ...loadConfig([]), dbPath: ':memory:' };
const db = openDb(':memory:');
const store = new Store(db, pino({ level: 'silent' }));
const dealId = 'PD-CACHECHECK';
const mandate = {
  floorOrCeiling: 450, openingOffer: 750, maxConcessionPerRound: 75, walkAwayAt: 6,
  dealbreakers: [], allowedShare: ['item_condition'], neverShare: ['floor'], secrets: { home_address: '1420 Valencia St Apt 3' },
};
db.insert(deals).values({ id: dealId, role: cfg.role, item: 'Test sofa', stage: 'NEGOTIATING', status: 'active', createdAt: now(), counterparty: { name: 'Test', kind: 'fo' } }).run();
db.insert(mandates).values({ dealId, data: mandate }).run();

console.log(`prefix TTL: ${cacheTtl()}\n`);
for (const n of [1, 2]) {
  const u = await prewarm({ store, fo: undefined as never, cfg, dealId });
  console.log(`orchestrator prefix, call ${n}: write=${u.cache_creation_input_tokens} read=${u.cache_read_input_tokens} uncached=${u.input_tokens}`,
    u.cache_creation ? JSON.stringify(u.cache_creation) : '');
}
for (const n of [1, 2]) await modelLeakCheck(`Hi, this is Agent 1's AI assistant. I can do $700 (try ${n}).`, mandate, cfg.role);
console.log('\nper-route stats:', JSON.stringify(cacheStats(), null, 2));
