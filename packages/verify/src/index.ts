import { and, eq, inArray } from 'drizzle-orm';
import { events, verifications, now, type DB } from '@proxydeal/core';
import { anthropic, model } from '@proxydeal/llm';

export interface Evidence { source: 'counterparty' | 'fo' | 'system'; ref: string; text: string }

export interface VerifyResult { passed: boolean; observed: string; evidence: string[] }

/** Which evidence sources may satisfy each stage. Agreement must come from the counterparty's own words. */
const TRUSTED: Record<string, Evidence['source'][]> = {
  NEGOTIATING: ['counterparty'],
  AGREED: ['counterparty'],
  ADDRESS_EXCHANGE: ['counterparty'],
  VERIFYING_HANDOFF: ['counterparty'],
  LOGISTICS: ['counterparty', 'fo'],
  PICKUP_PENDING: ['counterparty', 'fo'],
  PAYMENT: ['fo', 'system'],
  POST_SALE: ['counterparty', 'system'],
};

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

export function collectEvidence(db: DB, dealId: string): Evidence[] {
  const rows = db.select().from(events)
    .where(and(eq(events.dealId, dealId), inArray(events.kind, ['InboundMessage', 'ActionCompleted', 'PaymentRecorded'])))
    .all();
  return rows.map((r) => {
    const d = r.data as Record<string, string>;
    if (r.kind === 'InboundMessage') return { source: 'counterparty' as const, ref: `event:${r.id}`, text: d.text ?? '' };
    if (r.kind === 'PaymentRecorded') return { source: 'system' as const, ref: `event:${r.id}`, text: JSON.stringify(d) };
    return { source: 'fo' as const, ref: `event:${r.id}`, text: d.summary ?? '' };
  });
}

/**
 * Judge with the cheap model, then accept only quotes that literally appear in
 * trusted evidence. A model claim with no verbatim backing never passes.
 */
export async function verify(db: DB, dealId: string, stage: string, expected: string): Promise<VerifyResult> {
  const allowed = TRUSTED[stage] ?? ['counterparty'];
  const pool = collectEvidence(db, dealId).filter((e) => allowed.includes(e.source) && e.text);
  let result: VerifyResult;

  if (pool.length === 0) {
    result = { passed: false, observed: `No ${allowed.join('/')} evidence recorded yet`, evidence: [] };
  } else {
    const res = await anthropic().messages.create({
      model: model('cheap'),
      max_tokens: 2048,
      output_config: {
        effort: 'low',
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: {
              passed: { type: 'boolean' },
              observed: { type: 'string' },
              quotes: { type: 'array', items: { type: 'object', properties: { ref: { type: 'string' }, quote: { type: 'string' } }, required: ['ref', 'quote'], additionalProperties: false } },
            },
            required: ['passed', 'observed', 'quotes'],
            additionalProperties: false,
          },
        },
      },
      messages: [{
        role: 'user',
        content: `Decide whether the evidence proves this is true: "${expected}".\n` +
          `Be strict: a vague or conditional statement does not count, and the most recent statement wins if they conflict. ` +
          `Quote the exact supporting sentence(s) verbatim with their ref.\n\n` +
          pool.map((e) => `[${e.ref}] (${e.source}) ${e.text}`).join('\n\n'),
      }],
    });
    const text = res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
    let parsed: { passed: boolean; observed: string; quotes: { ref: string; quote: string }[] };
    try { parsed = JSON.parse(text); } catch { parsed = { passed: false, observed: 'Verifier output unparseable', quotes: [] }; }
    const backed = parsed.quotes.filter((q) => {
      const ev = pool.find((e) => e.ref === q.ref);
      return ev && q.quote.length > 3 && norm(ev.text).includes(norm(q.quote));
    });
    const passed = parsed.passed && backed.length > 0;
    result = {
      passed,
      observed: passed || !parsed.passed ? parsed.observed : `${parsed.observed} (rejected: quotes not found verbatim in trusted evidence)`,
      evidence: backed.map((q) => `${q.ref}: "${q.quote}"`),
    };
  }

  db.insert(verifications).values({ dealId, stage, expected, observed: result.observed, passed: result.passed, evidence: result.evidence, ts: now() }).run();
  return result;
}
