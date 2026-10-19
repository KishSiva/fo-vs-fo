import type { Channel, Mandate } from '@proxydeal/core';
import { anthropic, model } from './index.js';
import { prefixCache, trackUsage } from './cache.js';

export interface GuardResult {
  ok: boolean;
  script: string;
  removed: string[];
  reason?: string;
}

const DISCLOSURE = /\b(AI|automated)\s+(assistant|agent)\b/i;
const RECORDING = /\brecord(ed|ing)?\b/i;

export function checkDisclosure(channel: Channel, script: string): string | undefined {
  if (!DISCLOSURE.test(script)) return 'Script must open with an AI disclosure (e.g. "this is <owner>\'s AI assistant").';
  if (channel === 'call' && !RECORDING.test(script)) return 'Call scripts must include a recording notice ("this call may be recorded").';
  return undefined;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Regex pass: removes any private value (secrets, and the limit unless it is the offered amount or one the other side said). */
export function redactPrivate(script: string, m: Mandate, allowAmount?: number | number[]): { script: string; removed: string[] } {
  const allowed = Array.isArray(allowAmount) ? allowAmount : allowAmount === undefined ? [] : [allowAmount];
  const removed: string[] = [];
  let out = script;
  for (const [k, v] of Object.entries(m.secrets)) {
    if (!v) continue;
    // A private note that is just a price (e.g. target_price=265) is not a leak when that price is our own offer.
    const asNumber = Number(String(v).replace(/[$,\s]/g, ''));
    if (Number.isFinite(asNumber) && allowed.includes(asNumber)) continue;
    const re = new RegExp(esc(v), 'gi');
    if (re.test(out)) { removed.push(k); out = out.replace(re, '[withheld]'); }
  }
  if (!allowed.includes(m.floorOrCeiling)) {
    const n = m.floorOrCeiling;
    const re = new RegExp(`\\$?\\b${n}(\\.00)?\\b`, 'g');
    if (re.test(out)) { removed.push('price_limit'); out = out.replace(re, '[withheld]'); }
  }
  if (!allowed.includes(m.walkAwayAt)) {
    // Walk-away is a round count; only flag it when phrased as a limit.
    const re = new RegExp(`\\b${m.walkAwayAt}\\s+(more\\s+)?rounds?\\b`, 'gi');
    if (re.test(out)) { removed.push('walk_away'); out = out.replace(re, '[withheld]'); }
  }
  return { script: out, removed };
}

/** Model pass: catches paraphrased leaks the regex can't ("I can't go much under four-fifty"). */
export async function modelLeakCheck(script: string, m: Mandate, role: 'seller' | 'buyer', ctx: { offerAmount?: number; saidByThem?: number[] } = {}): Promise<{ leak: boolean; what: string[] }> {
  // Instructions + private facts are stable per deal: cached prefix. The message and per-turn context are the tail.
  const system = `A ${role}'s negotiation agent is about to send a message. PRIVATE facts it must not reveal, even indirectly (paraphrase, hints like "can't go much lower than", spelled-out numbers):\n` +
    `- ${role === 'seller' ? 'minimum acceptable price' : 'maximum budget'}: $${m.floorOrCeiling}\n` +
    Object.entries(m.secrets).map(([k, v]) => `- ${k}: ${v}`).join('\n') +
    (m.allowedShare.length ? `\nFacts the agent MAY share (never a leak, even if a private note mentions them too): ${m.allowedShare.join(', ')}.` : '') +
    '\nNOT leaks: stating the agent\'s own offer amount (even though offering implies room to move); repeating a number or fact the other side already said; ' +
    'citing public comparables or listing facts. Flag only a real private fact or a clear hint at the private limit. Does the message reveal any private fact? List which.';
  const res = await anthropic().messages.create({
    model: model('cheap'),
    max_tokens: 1024,
    system: [{ type: 'text', text: system, cache_control: prefixCache() }],
    output_config: {
      format: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: { leak: { type: 'boolean' }, what: { type: 'array', items: { type: 'string' } } },
          required: ['leak', 'what'],
          additionalProperties: false,
        },
      },
    },
    messages: [{ role: 'user', content: [
      ctx.offerAmount !== undefined ? `This message offers $${ctx.offerAmount}.` : '',
      ctx.saidByThem?.length ? `Numbers the other side already said: ${ctx.saidByThem.map((n) => `$${n}`).join(', ')}.` : '',
      `MESSAGE:\n${script}`,
    ].filter(Boolean).join('\n') }],
  });
  trackUsage('leak_check', res.usage);
  const text = res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
  try { return JSON.parse(text); } catch { return { leak: true, what: ['unparseable leak check (fail closed)'] }; }
}

/** Full outbound guard: disclosure (reject), regex redaction (strip), model check (reject). */
export async function guardOutbound(opts: {
  channel: Channel; script: string; mandate: Mandate; role: 'seller' | 'buyer'; offerAmount?: number; skipModel?: boolean;
  /** Amounts the other side already named: repeating them is not a leak. */
  saidByThem?: number[];
}): Promise<GuardResult> {
  const missing = checkDisclosure(opts.channel, opts.script);
  if (missing) return { ok: false, script: opts.script, removed: [], reason: missing };
  const allowed = [...(opts.offerAmount !== undefined ? [opts.offerAmount] : []), ...(opts.saidByThem ?? [])];
  const { script, removed } = redactPrivate(opts.script, opts.mandate, allowed);
  if (!opts.skipModel) {
    const lc = await modelLeakCheck(script, opts.mandate, opts.role, { offerAmount: opts.offerAmount, saidByThem: opts.saidByThem });
    if (lc.leak) return { ok: false, script, removed: [...removed, ...lc.what], reason: `Message reveals private information (${lc.what.join(', ')}). Rewrite it without hints about your limit or private details.` };
  }
  return { ok: true, script, removed };
}
