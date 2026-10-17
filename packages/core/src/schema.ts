import { sqliteTable, text, integer, real, index } from 'drizzle-orm/sqlite-core';
import type { Counterparty, Mandate } from './types.js';

export const deals = sqliteTable('deals', {
  id: text('id').primaryKey(),
  role: text('role').notNull(),
  item: text('item').notNull(),
  stage: text('stage').notNull(),
  status: text('status').notNull().default('active'),
  counterparty: text('counterparty', { mode: 'json' }).$type<Counterparty>().notNull(),
  createdAt: text('created_at').notNull(),
});

export const mandates = sqliteTable('mandates', {
  dealId: text('deal_id').primaryKey(),
  data: text('data', { mode: 'json' }).$type<Mandate>().notNull(),
});

export const offers = sqliteTable('offers', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  dealId: text('deal_id').notNull(),
  from: text('from').notNull(),
  amount: real('amount').notNull(),
  terms: text('terms').notNull().default(''),
  rationale: text('rationale').notNull().default(''),
  ts: text('ts').notNull(),
});

export const commitments = sqliteTable('commitments', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  dealId: text('deal_id').notNull(),
  who: text('who').notNull(),
  what: text('what').notNull(),
  dueAt: text('due_at'),
  status: text('status').notNull().default('open'),
  evidence: text('evidence'),
});

export const actions = sqliteTable('actions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  dealId: text('deal_id').notNull(),
  stage: text('stage').notNull(),
  channel: text('channel').notNull(),
  target: text('target').notNull(),
  objective: text('objective').notNull(),
  foTaskId: text('fo_task_id'),
  outcome: text('outcome'),
  rawResult: text('raw_result'),
  startedAt: text('started_at').notNull(),
  endedAt: text('ended_at'),
});

export const approvals = sqliteTable('approvals', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  dealId: text('deal_id').notNull(),
  tier: integer('tier').notNull(),
  summary: text('summary').notNull(),
  payload: text('payload', { mode: 'json' }).notNull(),
  payloadHash: text('payload_hash').notNull(),
  status: text('status').notNull().default('pending'),
  createdAt: text('created_at').notNull(),
  decidedAt: text('decided_at'),
  decidedBy: text('decided_by'),
});

export const jobs = sqliteTable('jobs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  dealId: text('deal_id'),
  runAt: text('run_at').notNull(),
  type: text('type').notNull(),
  payload: text('payload', { mode: 'json' }).notNull(),
  attempts: integer('attempts').notNull().default(0),
  status: text('status').notNull().default('pending'),
  lockedAt: text('locked_at'),
}, (t) => [index('jobs_status_run').on(t.status, t.runAt)]);

export const events = sqliteTable('events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  dealId: text('deal_id').notNull(),
  ts: text('ts').notNull(),
  kind: text('kind').notNull(),
  actor: text('actor').notNull(),
  data: text('data', { mode: 'json' }).notNull(),
}, (t) => [index('events_deal_ts').on(t.dealId, t.ts)]);

export const verifications = sqliteTable('verifications', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  dealId: text('deal_id').notNull(),
  stage: text('stage').notNull(),
  expected: text('expected').notNull(),
  observed: text('observed').notNull(),
  passed: integer('passed', { mode: 'boolean' }).notNull(),
  evidence: text('evidence', { mode: 'json' }).$type<string[]>().notNull(),
  ts: text('ts').notNull(),
});

export const dnc = sqliteTable('dnc', {
  target: text('target').primaryKey(),
  reason: text('reason').notNull(),
  ts: text('ts').notNull(),
});

export const foCapabilities = sqliteTable('fo_capabilities', {
  key: text('key').primaryKey(),
  toolName: text('tool_name'),
  schema: text('schema', { mode: 'json' }),
});

/** Triggers already processed (idempotency) and seen inbound Fo conversations. */
export const processed = sqliteTable('processed', {
  id: text('id').primaryKey(),
  ts: text('ts').notNull(),
});

export const DDL = `
CREATE TABLE IF NOT EXISTS deals (id TEXT PRIMARY KEY, role TEXT NOT NULL, item TEXT NOT NULL, stage TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', counterparty TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS mandates (deal_id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS offers (id INTEGER PRIMARY KEY AUTOINCREMENT, deal_id TEXT NOT NULL, "from" TEXT NOT NULL, amount REAL NOT NULL, terms TEXT NOT NULL DEFAULT '', rationale TEXT NOT NULL DEFAULT '', ts TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS commitments (id INTEGER PRIMARY KEY AUTOINCREMENT, deal_id TEXT NOT NULL, who TEXT NOT NULL, what TEXT NOT NULL, due_at TEXT, status TEXT NOT NULL DEFAULT 'open', evidence TEXT);
CREATE TABLE IF NOT EXISTS actions (id INTEGER PRIMARY KEY AUTOINCREMENT, deal_id TEXT NOT NULL, stage TEXT NOT NULL, channel TEXT NOT NULL, target TEXT NOT NULL, objective TEXT NOT NULL, fo_task_id TEXT, outcome TEXT, raw_result TEXT, started_at TEXT NOT NULL, ended_at TEXT);
CREATE TABLE IF NOT EXISTS approvals (id INTEGER PRIMARY KEY AUTOINCREMENT, deal_id TEXT NOT NULL, tier INTEGER NOT NULL, summary TEXT NOT NULL, payload TEXT NOT NULL, payload_hash TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, decided_at TEXT, decided_by TEXT);
CREATE TABLE IF NOT EXISTS jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, deal_id TEXT, run_at TEXT NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending', locked_at TEXT);
CREATE INDEX IF NOT EXISTS jobs_status_run ON jobs(status, run_at);
CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, deal_id TEXT NOT NULL, ts TEXT NOT NULL, kind TEXT NOT NULL, actor TEXT NOT NULL, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS events_deal_ts ON events(deal_id, ts);
CREATE TABLE IF NOT EXISTS verifications (id INTEGER PRIMARY KEY AUTOINCREMENT, deal_id TEXT NOT NULL, stage TEXT NOT NULL, expected TEXT NOT NULL, observed TEXT NOT NULL, passed INTEGER NOT NULL, evidence TEXT NOT NULL, ts TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS dnc (target TEXT PRIMARY KEY, reason TEXT NOT NULL, ts TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS fo_capabilities (key TEXT PRIMARY KEY, tool_name TEXT, schema TEXT);
CREATE TABLE IF NOT EXISTS processed (id TEXT PRIMARY KEY, ts TEXT NOT NULL);
`;
