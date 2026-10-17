import { describe, it, expect } from 'vitest';
import { checkOffer, acceptable, nearLimit, redactMandate, requiresVerification, canTransition, type Mandate } from '@proxydeal/core';
import { checkDisclosure, redactPrivate, renderRequestForTest } from './helpers.js';

const seller: Mandate = {
  floorOrCeiling: 450, openingOffer: 750, maxConcessionPerRound: 75, walkAwayAt: 6,
  dealbreakers: [], allowedShare: ['item_condition'], neverShare: ['floor', 'home_address_before_agreement'],
  secrets: { home_address: '1420 Valencia St Apt 3', payment_details: 'venmo @agent1-demo-7731' },
};

describe('mandate guard', () => {
  it('rejects seller offers below floor', () => {
    expect(checkOffer('seller', seller, 449, 500).ok).toBe(false);
    expect(checkOffer('seller', seller, 450, 500).ok).toBe(true);
  });
  it('rejects buyer offers above ceiling', () => {
    expect(checkOffer('buyer', { ...seller, floorOrCeiling: 600 }, 601, 580).ok).toBe(false);
  });
  it('caps concession per round', () => {
    expect(checkOffer('seller', seller, 674, 750).ok).toBe(false);
    expect(checkOffer('seller', seller, 675, 750).ok).toBe(true);
  });
  it('rejection messages never include the limit', () => {
    expect(checkOffer('seller', seller, 100, undefined).reason).not.toContain('450');
  });
  it('flags acceptance near the limit for tier-2 approval', () => {
    expect(acceptable('seller', seller, 470)).toBe(true);
    expect(nearLimit('seller', seller, 470)).toBe(true);
    expect(nearLimit('seller', seller, 600)).toBe(false);
  });
  it('API view of the mandate drops limit, walk-away and secrets', () => {
    const r = redactMandate(seller) as Record<string, unknown>;
    expect(r.floorOrCeiling).toBeUndefined();
    expect(r.walkAwayAt).toBeUndefined();
    expect(r.secrets).toBeUndefined();
    expect(JSON.stringify(r)).not.toContain('450');
  });
});

describe('redaction guard', () => {
  it('strips the limit and secrets from outbound scripts', () => {
    const { script, removed } = redactPrivate('I really can\'t go below $450. Pick up at 1420 Valencia St Apt 3, venmo @agent1-demo-7731', seller);
    expect(script).not.toContain('450');
    expect(script).not.toContain('Valencia');
    expect(script).not.toContain('@agent1-demo');
    expect(removed).toEqual(expect.arrayContaining(['price_limit', 'home_address', 'payment_details']));
  });
  it('allows the limit only when it is the amount being offered', () => {
    expect(redactPrivate('I can do $450.', seller, 450).removed).toEqual([]);
  });
});

describe('disclosure guard', () => {
  it('requires AI disclosure on every channel', () => {
    expect(checkDisclosure('text', 'Hey, still want the couch?')).toBeDefined();
    expect(checkDisclosure('text', "Hi, this is Agent 1's AI assistant.")).toBeUndefined();
  });
  it('requires a recording notice on calls', () => {
    expect(checkDisclosure('call', "Hi, this is Agent 1's AI assistant.")).toBeDefined();
    expect(checkDisclosure('call', "Hi, this is Agent 1's AI assistant; this call may be recorded.")).toBeUndefined();
  });
  it('Fo request wraps the script verbatim with no-extra-info rules', () => {
    const msg = renderRequestForTest();
    expect(msg).toContain('<<<\nHi, this is Agent 1');
    expect(msg).toContain('Do not share any information beyond what is written here.');
  });
});

describe('state machine', () => {
  it('every forward stage change needs verification; abandon does not', () => {
    expect(requiresVerification('NEGOTIATING', 'AGREED')).toBe(true);
    expect(requiresVerification('POST_SALE', 'CLOSED')).toBe(true);
    expect(requiresVerification('NEGOTIATING', 'ABANDONED')).toBe(false);
  });
  it('cannot skip stages', () => {
    expect(canTransition('NEGOTIATING', 'PAYMENT')).toBe(false);
    expect(canTransition('NEGOTIATING', 'CLOSED')).toBe(false);
  });
});
