import type { Channel, Mandate } from '@proxydeal/core';
import { anthropic, model } from './index.js';

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

/** Regex pass: removes any private value (secrets, and the limit unless it is the offered amount). */
export function redactPrivate(script: string, m: Mandate, allowAmount?: number): { script: string; removed: string[] } {
  const removed: string[] = [];
  let out = script;
  for (const [k, v] of Object.entries(m.secrets)) {
    if (!v) continue;
    const re = new RegExp(esc(v), 'gi');
    if (re.test(out)) { removed.push(k); out = out.replace(re, '[withheld]'); }
  }
  if (allowAmount !== m.floorOrCeiling) {
    const n = m.floorOrCeiling;
    const re = new RegExp(`\\$?\\b${n}(\\.00)?\\b`, 'g');
    if (re.test(out)) { removed.push('price_limit'); out = out.replace(re, '[withheld]'); }
  }
  if (allowAmount !== m.walkAwayAt) {
    // Walk-away is a round count; only flag it when phrased as a limit.
    const re = new RegExp(`\\b${m.walkAwayAt}\\s+(more\\s+)?rounds?\\b`, 'gi');
    if (re.test(out)) { removed.push('walk_away'); out = out.replace(re, '[withheld]'); }
  }
  return { script: out, removed };
}

/** Model pass: catches paraphrased leaks the regex can't ("I can't go much under four-fifty"). */
export async function modelLeakCheck(script: string, m: Mandate, role: 'seller' | 'buyer'): Promise<{ leak: boolean; what: string[] }> {
  const res = await anthropic().messages.create({
    model: model('cheap'),
    max_tokens: 1024,
    output_config: {
      effort: 'low',
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
    messages: [{
      role: 'user',
      content: `A ${role}'s negotiation agent is about to send the message below. PRIVATE facts it must not reveal, even indirectly (paraphrase, hints like "can't go much lower than", spelled-out numbers):\n` +
        `- ${role === 'seller' ? 'minimum acceptable price' : 'maximum budget'}: $${m.floorOrCeiling}\n` +
        Object.entries(m.secrets).map(([k, v]) => `- ${k}: ${v}`).join('\n') +
        `\nStating a concrete offer amount is fine. Does the message reveal any private fact? List which.\n\nMESSAGE:\n${script}`,
    }],
  });
  const text = res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
  try { return JSON.parse(text); } catch { return { leak: true, what: ['unparseable leak check (fail closed)'] }; }
}

/** Full outbound guard: disclosure (reject), regex redaction (strip), model check (reject). */
export async function guardOutbound(opts: {
  channel: Channel; script: string; mandate: Mandate; role: 'seller' | 'buyer'; offerAmount?: number; skipModel?: boolean;
}): Promise<GuardResult> {
  const missing = checkDisclosure(opts.channel, opts.script);
  if (missing) return { ok: false, script: opts.script, removed: [], reason: missing };
  const { script, removed } = redactPrivate(opts.script, opts.mandate, opts.offerAmount);
  if (!opts.skipModel) {
    const lc = await modelLeakCheck(script, opts.mandate, opts.role);
    if (lc.leak) return { ok: false, script, removed: [...removed, ...lc.what], reason: `Message reveals private information (${lc.what.join(', ')}). Rewrite it without hints about your limit or private details.` };
  }
  return { ok: true, script, removed };
}
