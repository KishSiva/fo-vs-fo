import type { Mandate, Role } from './types.js';

export interface OfferCheck { ok: boolean; reason?: string }

/**
 * Server-side mandate guard. Seller offers must stay >= floor; buyer offers <= ceiling.
 * Concessions (moving toward the counterparty) are capped per round.
 */
export function checkOffer(role: Role, m: Mandate, amount: number, lastSelfOffer: number | undefined): OfferCheck {
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, reason: 'Offer amount must be a positive number' };
  if (role === 'seller' && amount < m.floorOrCeiling)
    return { ok: false, reason: 'Offer is below your mandate. Choose a higher amount.' };
  if (role === 'buyer' && amount > m.floorOrCeiling)
    return { ok: false, reason: 'Offer is above your mandate. Choose a lower amount.' };
  if (lastSelfOffer !== undefined) {
    const concession = role === 'seller' ? lastSelfOffer - amount : amount - lastSelfOffer;
    if (concession > m.maxConcessionPerRound)
      return { ok: false, reason: `Concession of ${concession} exceeds the max of ${m.maxConcessionPerRound} per round.` };
  }
  return { ok: true };
}

/** Is accepting this counterparty price within mandate? */
export function acceptable(role: Role, m: Mandate, price: number): boolean {
  return role === 'seller' ? price >= m.floorOrCeiling : price <= m.floorOrCeiling;
}

/** Within 10% of the limit counts as "near mandate limit" -> tier-2 approval. */
export function nearLimit(role: Role, m: Mandate, price: number): boolean {
  const band = Math.abs(m.floorOrCeiling) * 0.1;
  return role === 'seller' ? price <= m.floorOrCeiling + band : price >= m.floorOrCeiling - band;
}

/** Mandate view safe to send anywhere outside the proxy (API, dashboard). */
export function redactMandate(m: Mandate) {
  const { floorOrCeiling: _f, walkAwayAt: _w, secrets: _s, ...rest } = m;
  return rest;
}
