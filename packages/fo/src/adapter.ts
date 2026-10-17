import type { Channel } from '@proxydeal/core';
import type { CapabilityMap } from './capabilities.js';
import type { FoConnection } from './client.js';

export interface FoActRequest {
  channel: Channel;
  to: string;
  objective: string;
  /** Exact words to send (email/text) or the opening + talking points (call). Already guarded. */
  script: string;
  constraints: string[];
  mustDisclose: true;
  maxDurationMin?: number;
  dealId: string;
}

export interface FoPayRequest { to: string; amount: number; memo: string; dealId: string }

export type FoTaskState = 'working' | 'complete' | 'failed' | 'needs_input';

export interface FoStatus {
  state: FoTaskState;
  summary?: string;
  transcript?: FoTurn[];
  artifacts: string[];
  progress?: string;
}

export interface FoTurn { role: string; text: string; at: string }

export interface FoInbound {
  conversationId: string;
  channel: string;
  title: string;
  startedAt: string;
  turns: FoTurn[];
}

export interface FoAdapter {
  act(req: FoActRequest): Promise<{ foTaskId: string; status: FoStatus }>;
  status(foTaskId: string): Promise<FoStatus>;
  pay(req: FoPayRequest): Promise<{ foTaskId: string; status: FoStatus }>;
  /** Conversations on non-app channels (sms/email/voice) started after `since`, with their turns. */
  inbound(since: string, ignore: Set<string>): Promise<FoInbound[]>;
  transcript(foTaskId: string): Promise<FoTurn[]>;
  /** Private instructions to this proxy's own Fo (no outbound contact). */
  brief(dealId: string, message: string): Promise<{ foTaskId: string; status: FoStatus }>;
}

/** Turns a structured action into the plain-language request Fo's ask_fo expects. */
export function renderRequest(req: FoActRequest): string {
  const tag = `[ProxyDeal ${req.dealId}]`;
  // On calls the constraints grant price authority; the generic text rules would make Fo refuse to negotiate.
  const rules = req.channel === 'call'
    ? [...req.constraints, 'Share only the item facts and terms in these instructions. Make no payments or purchases.']
    : [
      ...req.constraints,
      'Do not share any information beyond what is written here.',
      'Do not make commitments, payments or purchases beyond what is written here.',
    ];
  const how = {
    text: `Send a text message to ${req.to}. Send exactly the message between the markers, verbatim, with no additions:`,
    email: `Send an email to ${req.to} with subject "${tag} ${req.objective}". Use exactly the body between the markers, verbatim:`,
    call: `Place a phone call to ${req.to}. Keep it under ${req.maxDurationMin ?? 10} minutes. Open with the first paragraph between the markers word for word, then negotiate live to a conclusion using the talking points and the rules below:`,
  }[req.channel];
  const report = req.channel === 'call'
    ? 'When the call ends, reply with a short summary and finish with a JSON block: {"outcome": "...", "agreedPrice": number|null, "commitments": ["..."]}.'
    : 'When sent, reply "SENT" and quote the exact message you sent.';
  return [
    `${tag} Objective: ${req.objective}`,
    how,
    '<<<',
    req.script,
    '>>>',
    `Rules:\n${rules.map((r) => `- ${r}`).join('\n')}`,
    report,
  ].join('\n');
}

interface AskReply { response?: string; status?: string; progress?: string; conversationId?: string; error?: string }

/** Fo puts its data in structuredContent; the text content is a human-readable rendering. */
function parseToolText(raw: unknown): unknown {
  const r = raw as { content?: unknown; structuredContent?: unknown; isError?: boolean };
  const text = ((r.content ?? []) as { type: string; text?: string }[]).map((c) => c.text ?? '').join('');
  if (r.isError) throw new Error(`Fo tool error: ${text.slice(0, 300)}`);
  if (r.structuredContent && typeof r.structuredContent === 'object') return { response: text, ...r.structuredContent };
  try { return JSON.parse(text); } catch { return { response: text }; }
}

function toStatus(r: AskReply): FoStatus {
  const s = r.status ?? 'complete';
  const waiting = /waiting for (the )?user|your answer/i.test(r.progress ?? '');
  return {
    state: s === 'working' ? (waiting ? 'needs_input' : 'working') : s === 'failed' ? 'failed' : 'complete',
    summary: r.response ?? r.error,
    progress: r.progress,
    artifacts: [],
  };
}

/** Real Fo via MCP. Every tool name comes from the discovered capability map. */
export class McpFoAdapter implements FoAdapter {
  constructor(private readonly fo: FoConnection, private readonly caps: CapabilityMap) {}

  private tool(key: keyof CapabilityMap): string {
    const t = this.caps[key]?.toolName;
    if (!t) throw new Error(`Fo has no tool for capability "${key}"`);
    return t;
  }

  async act(req: FoActRequest) {
    const r = parseToolText(await this.fo.callTool(this.tool(req.channel), {
      message: renderRequest(req),
      newConversation: true,
    })) as AskReply;
    if (!r.conversationId) throw new Error(`Fo did not return a conversation id: ${JSON.stringify(r).slice(0, 200)}`);
    return { foTaskId: r.conversationId, status: toStatus(r) };
  }

  async status(foTaskId: string) {
    const r = parseToolText(await this.fo.callTool(this.tool('status'), { conversationId: foTaskId, waitSeconds: 10 })) as AskReply;
    const st = toStatus(r);
    if (st.state === 'complete' || st.state === 'failed') st.transcript = await this.transcript(foTaskId);
    return st;
  }

  async pay(req: FoPayRequest) {
    const message = `[ProxyDeal ${req.dealId}] Send a payment of exactly $${req.amount.toFixed(2)} to ${req.to}. Memo: "${req.memo}". ` +
      'Do not pay any other amount or recipient. Reply with the payment confirmation or reference number.';
    const r = parseToolText(await this.fo.callTool(this.tool('pay'), { message, newConversation: true })) as AskReply;
    if (!r.conversationId) throw new Error('Fo did not return a conversation id');
    return { foTaskId: r.conversationId, status: toStatus(r) };
  }

  async brief(dealId: string, message: string) {
    const text = `[ProxyDeal ${dealId}] Private briefing from my negotiation agent.\n${message}`;
    const r = parseToolText(await this.fo.callTool(this.tool('call'), { message: text, newConversation: true })) as AskReply;
    if (!r.conversationId) throw new Error('Fo did not return a conversation id');
    return { foTaskId: r.conversationId, status: toStatus(r) };
  }

  async transcript(foTaskId: string): Promise<FoTurn[]> {
    const r = parseToolText(await this.fo.callTool(this.tool('thread_read'), { conversationId: foTaskId })) as { turns?: FoTurn[] };
    return r.turns ?? [];
  }

  async inbound(since: string, ignore: Set<string>): Promise<FoInbound[]> {
    const r = parseToolText(await this.fo.callTool(this.tool('threads'), {})) as {
      conversations?: { conversationId: string; title: string; channel: string; startedAt: string }[];
    };
    const fresh = (r.conversations ?? []).filter(
      (c) => c.channel !== 'chat' && c.startedAt >= since && !ignore.has(c.conversationId),
    );
    const out: FoInbound[] = [];
    for (const c of fresh) {
      out.push({ conversationId: c.conversationId, channel: c.channel, title: c.title, startedAt: c.startedAt, turns: await this.transcript(c.conversationId) });
    }
    return out;
  }
}
