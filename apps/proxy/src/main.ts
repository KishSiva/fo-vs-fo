import { existsSync, readFileSync } from 'node:fs';
import pino from 'pino';
import { openDb, foCapabilities } from '@proxydeal/core';
import { connectFo, McpFoAdapter, MockFoAdapter, buildCapabilityMap, type FoAdapter, type CapabilityMap, type FoConnection } from '@proxydeal/fo';
import { loadConfig } from './config.js';
import { Store } from './store.js';
import { Worker } from './worker.js';
import { startApi } from './api.js';
import { pollInbound } from './inbound.js';

const cfg = loadConfig(process.argv);
const log = pino({ name: cfg.proxyId, level: process.env.LOG_LEVEL ?? 'info' });
const db = openDb(cfg.dbPath);
const store = new Store(db, log);

/** Lazily connects on first Fo call, so the API is up even before sign-in. */
class LazyFo implements FoAdapter {
  private inner?: Promise<FoAdapter>;
  constructor(private make: () => Promise<FoAdapter>) {}
  private get() { return (this.inner ??= this.make().catch((e) => { this.inner = undefined; throw e; })); }
  act: FoAdapter['act'] = async (r) => (await this.get()).act(r);
  status: FoAdapter['status'] = async (id) => (await this.get()).status(id);
  pay: FoAdapter['pay'] = async (r) => (await this.get()).pay(r);
  inbound: FoAdapter['inbound'] = async (s, i) => (await this.get()).inbound(s, i);
  transcript: FoAdapter['transcript'] = async (id) => (await this.get()).transcript(id);
  brief: FoAdapter['brief'] = async (d, m) => (await this.get()).brief(d, m);
  reply: FoAdapter['reply'] = async (id, m) => (await this.get()).reply(id, m);
  quoteThread: FoAdapter['quoteThread'] = async (id, t, s, r) => (await this.get()).quoteThread(id, t, s, r);
}

let foConn: FoConnection | undefined;
const capsFile = `config/fo-capabilities.${cfg.proxyId}.json`;

const mockFo = cfg.mockFo ? new MockFoAdapter('data/mock-fo-bus.db', [cfg.ownerPhone, cfg.ownerEmail].filter(Boolean) as string[], cfg.owner) : undefined;
const fo: FoAdapter = mockFo ?? new LazyFo(async () => {
      foConn = await connectFo({ url: cfg.foMcpUrl, role: cfg.proxyId, ownerName: cfg.owner, callbackPort: cfg.foOauthPort });
      let caps: CapabilityMap;
      if (existsSync(capsFile)) caps = JSON.parse(readFileSync(capsFile, 'utf8')).map;
      else {
        log.warn(`${capsFile} missing; building capability map now (run pnpm discover:fo to review it)`);
        caps = await buildCapabilityMap((await foConn.listTools()).tools);
      }
      for (const [key, e] of Object.entries(caps))
        db.insert(foCapabilities).values({ key, toolName: e.toolName, schema: { viaAgent: e.viaAgent, source: e.source } })
          .onConflictDoUpdate({ target: foCapabilities.key, set: { toolName: e.toolName } }).run();
      return new McpFoAdapter(foConn, caps);
    });

const worker = new Worker(store, fo, cfg);
const foSignedIn = () => cfg.mockFo || existsSync(`.fo-auth/${cfg.proxyId}.json`) && Boolean(JSON.parse(readFileSync(`.fo-auth/${cfg.proxyId}.json`, 'utf8')).tokens);

if (process.argv.includes('--once')) {
  // One pass of the loop: read new texts from Fo, then let Claude act on each (and anything else that's due).
  store.recoverJobs();
  await pollInbound(store, fo, cfg);
  const n = await worker.tick();
  log.info({ jobs: n }, 'ran due jobs once');
  process.exit(0);
}

worker.start();
await startApi(store, cfg, worker, foSignedIn, fo, mockFo);
log.info({ port: cfg.port, mockFo: cfg.mockFo }, `${cfg.owner} proxy (${cfg.role}) up`);

for (const sig of ['SIGINT', 'SIGTERM'] as const)
  process.on(sig, async () => { worker.stop(); await foConn?.close().catch(() => {}); process.exit(0); });
