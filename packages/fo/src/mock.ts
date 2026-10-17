import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FoActRequest, FoAdapter, FoInbound, FoPayRequest, FoStatus, FoTurn } from './adapter.js';

/**
 * Offline Fo: a shared SQLite file acts as the phone/email network between
 * proxies. act() "delivers" the script to the target address; inbound() returns
 * messages addressed to this proxy's own addresses, shaped like Fo sms threads.
 * A persona simulator can sit on the other end by reading/writing the same bus.
 */
export class MockFoAdapter implements FoAdapter {
  private db: Database.Database;

  constructor(busPath: string, private readonly myAddresses: string[], private readonly myName: string) {
    mkdirSync(dirname(busPath), { recursive: true });
    this.db = new Database(busPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`CREATE TABLE IF NOT EXISTS bus (id INTEGER PRIMARY KEY AUTOINCREMENT, conv TEXT, sender TEXT, recipient TEXT, channel TEXT, text TEXT, at TEXT);
                  CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, summary TEXT, turns TEXT);`);
  }

  private deliver(channel: string, to: string, text: string) {
    const sender = this.address;
    // One thread per sender->recipient pair, like an sms conversation.
    const conv = `mock:${[sender, to].sort().join('|')}`;
    this.db.prepare('INSERT INTO bus (conv, sender, recipient, channel, text, at) VALUES (?,?,?,?,?,?)')
      .run(conv, sender, to, channel === 'call' ? 'voice' : channel === 'text' ? 'sms' : channel, text, new Date().toISOString());
  }

  private task(summary: string, request: string): { foTaskId: string; status: FoStatus } {
    const id = `mock-task-${randomUUID()}`;
    const at = new Date().toISOString();
    const turns: FoTurn[] = [{ role: 'user', text: request, at }, { role: 'assistant', text: summary, at }];
    this.db.prepare('INSERT INTO tasks (id, summary, turns) VALUES (?,?,?)').run(id, summary, JSON.stringify(turns));
    return { foTaskId: id, status: { state: 'complete', summary, artifacts: [] } };
  }

  async act(req: FoActRequest) {
    this.deliver(req.channel, req.to, req.script);
    return this.task(`SENT (${req.channel} to ${req.to}): ${req.script}`, req.objective);
  }

  async status(foTaskId: string): Promise<FoStatus> {
    const row = this.db.prepare('SELECT summary, turns FROM tasks WHERE id = ?').get(foTaskId) as { summary: string; turns: string } | undefined;
    if (!row) return { state: 'failed', summary: 'unknown task', artifacts: [] };
    return { state: 'complete', summary: row.summary, transcript: JSON.parse(row.turns), artifacts: [] };
  }

  async pay(req: FoPayRequest) {
    return this.task(`Payment sent: $${req.amount.toFixed(2)} to ${req.to}, memo "${req.memo}", ref MOCKPAY-${Date.now()}`, req.memo);
  }

  async brief(_dealId: string, message: string) {
    return this.task('Understood.', message);
  }

  async transcript(foTaskId: string) {
    return (await this.status(foTaskId)).transcript ?? [];
  }

  async inbound(since: string, _ignore: Set<string>): Promise<FoInbound[]> {
    const mine = this.myAddresses.length ? this.myAddresses : [this.address];
    const ph = mine.map(() => '?').join(',');
    const rows = this.db.prepare(`SELECT * FROM bus WHERE recipient IN (${ph}) AND at >= ? ORDER BY id`).all(...mine, since) as
      { conv: string; sender: string; channel: string; text: string; at: string }[];
    const byConv = new Map<string, FoInbound>();
    for (const r of rows) {
      const c = byConv.get(r.conv) ?? { conversationId: r.conv, channel: r.channel, title: `From ${r.sender}`, startedAt: r.at, turns: [] };
      c.turns.push({ role: 'user', text: r.text, at: r.at });
      byConv.set(r.conv, c);
    }
    return [...byConv.values()];
  }

  /** This Fo's own number on the mock network. */
  get address() { return this.myAddresses[0] ?? this.myName; }

  /** Both directions between this Fo and one address, oldest first (rehearsal UI). */
  thread(other: string): { from: string; to: string; text: string; at: string }[] {
    const me = this.address;
    return this.db.prepare('SELECT sender AS "from", recipient AS "to", text, at FROM bus WHERE (sender = ? AND recipient = ?) OR (sender = ? AND recipient = ?) ORDER BY id')
      .all(me, other, other, me) as { from: string; to: string; text: string; at: string }[];
  }

  /** Test helper: inject a message as if a human/business sent it. */
  inject(from: string, to: string, channel: 'sms' | 'email' | 'voice', text: string) {
    const conv = `mock:${[from, to].sort().join('|')}`;
    this.db.prepare('INSERT INTO bus (conv, sender, recipient, channel, text, at) VALUES (?,?,?,?,?,?)').run(conv, from, to, channel, text, new Date().toISOString());
  }
}
