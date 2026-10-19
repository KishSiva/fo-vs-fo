import { describe, it, expect } from 'vitest';
import { planProblems, planText, type DealPlan } from '@proxydeal/llm';

const plan = (over: Partial<DealPlan> = {}): DealPlan => ({
  marketRead: 'Used Sayls go for $200-325.',
  askingPrice: 350,
  comps: [{ label: 'Refurbished, dealer', price: 359, kind: 'refurbished', url: '' }],
  prices: { open: 220, target: 265, happy: 280, limit: 300 },
  theirInterests: [{ signal: 'Clearing an office', use: 'Offer a fast pickup' }],
  opener: "Hi, this is Spencer's AI assistant. Are the Sayls still available?",
  discovery: ['Which configuration?'],
  ladder: [{ amount: 220, reason: 'as-is vs refurbished' }, { amount: 245, reason: 'Tuesday pickup' }, { amount: 268, reason: 'final' }],
  trades: ['Carry it out myself'],
  tactics: ['Label the $300 vs $350 gap'],
  dealbreakers: ['Stains or tears'],
  niceToHaves: ['Fully loaded'],
  checkWithOwner: ['Any final price'],
  walkAway: 'Politely leave the door open.',
  ...over,
});

describe('planProblems', () => {
  it('accepts a sound buyer plan', () => expect(planProblems('buyer', plan())).toEqual([]));
  it('flags prices out of order', () =>
    expect(planProblems('buyer', plan({ prices: { open: 220, target: 290, happy: 280, limit: 300 } })).join(' ')).toMatch(/open ≤ target/));
  it('flags a ladder that goes backwards or past the max', () => {
    const p = planProblems('buyer', plan({ ladder: [{ amount: 240, reason: '' }, { amount: 230, reason: '' }, { amount: 310, reason: '' }] }));
    expect(p.join(' ')).toMatch(/moves backwards/);
    expect(p.join(' ')).toMatch(/past your max/);
  });
  it('requires the AI disclosure in the opener', () => expect(planProblems('buyer', plan({ opener: 'hey, still available?' }))).toContain('The opener must say it is an AI assistant.'));
  it('runs the other way for a seller', () =>
    expect(planProblems('seller', plan({ prices: { open: 350, target: 320, happy: 310, limit: 290 }, ladder: [{ amount: 340, reason: '' }, { amount: 325, reason: '' }] }))).toEqual([]));
});

describe('planText', () => {
  it('includes the prices and ladder for the agent', () => {
    const t = planText(plan(), 'buyer');
    expect(t).toContain('max $300');
    expect(t).toContain('3. $268: final');
    expect(t).toContain('Label the $300 vs $350 gap');
  });
});
