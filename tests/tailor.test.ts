import { describe, it, expect, vi } from 'vitest';
import type { DealPlan } from '@proxydeal/llm';

process.env.MODEL_ORCHESTRATOR ??= 'test-model';
const reply = vi.fn();
vi.mock('../packages/llm/src/index.js', async (orig) => ({
  ...(await orig<typeof import('../packages/llm/src/index.js')>()),
  anthropic: () => ({ messages: { create: reply } }),
}));
const { tailorPlan } = await import('../packages/llm/src/plan.js');

const base: DealPlan = {
  marketRead: 'Used Sayls go for $200-325.', askingPrice: 300,
  comps: [{ label: 'Refurbished, dealer', price: 359, kind: 'refurbished', url: '' }],
  prices: { open: 220, target: 250, happy: 265, limit: 290 },
  theirInterests: [{ signal: '8 chairs to clear', use: 'offer a fast pickup' }],
  opener: "Hi, this is Spencer's AI assistant. Are the chairs still available?", discovery: ['Are all 8 the same?'],
  ladder: [{ amount: 220, reason: 'as-is' }, { amount: 245, reason: 'pickup' }, { amount: 262, reason: 'final' }],
  trades: ['pick any chair'], tactics: ['label the clear-out'], dealbreakers: [], niceToHaves: [], checkWithOwner: ['any final price'], walkAway: 'leave the door open',
};
const asJson = (input: object) => ({ content: [{ type: 'text', text: JSON.stringify(input) }], usage: { input_tokens: 0, output_tokens: 0 } });

describe('tailoring the plan to another seller', () => {
  it("adapts the wording but keeps the owner's prices and comps", async () => {
    reply.mockResolvedValueOnce(asJson({ ...base, askingPrice: 280, opener: "Hi, this is Spencer's AI assistant. Is your Sayl still available?",
      discovery: ['Does the seat slider work?'], prices: { open: 100, target: 120, happy: 130, limit: 400 }, comps: [] }));
    const r = await tailorPlan({ role: 'buyer', owner: 'Spencer', base, listing: '8 Sayls, $300', sellerListing: 'One Sayl, $280 obo' });
    expect(r.tailored).toBe(true);
    expect(r.plan.opener).toContain('Is your Sayl');
    expect(r.plan.askingPrice).toBe(280);
    expect(r.plan.prices).toEqual(base.prices);
    expect(r.plan.comps).toEqual(base.comps);
  });

  it('falls back to the shared plan when the result breaks a rule', async () => {
    reply.mockResolvedValueOnce(asJson({ ...base, opener: 'hey is it available?' }));
    const r = await tailorPlan({ role: 'buyer', owner: 'Spencer', base, listing: 'a', sellerListing: 'b' });
    expect(r).toEqual({ plan: base, tailored: false });
  });
});
