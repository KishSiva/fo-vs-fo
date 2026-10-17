/**
 * pnpm seed [--deal PD-XXXX] [--reset]
 * Creates the couch deal in both proxies' DBs (same deal id) and queues the
 * seller's opening turn. Mandates are private per proxy.
 */
import { parse } from 'dotenv';
import { readFileSync, rmSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { openDb, deals, mandates, jobs, now, CHANNEL_PREFS, type ChannelPref, type Mandate } from '@proxydeal/core';

const arg = (k: string) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : undefined; };
const dealId = arg('--deal') ?? `PD-${randomBytes(3).toString('hex').toUpperCase()}`;
const reset = process.argv.includes('--reset');
const ITEM = 'West Elm Hamilton 84" sofa, 3 years old (paid $1,899). Facts you may share: no stains, no pets, smoke-free home; ' +
  'slight pilling on the left seat cushion; buyer can inspect before paying; fits through a standard 32" door with legs off.';

const MANDATES: Record<'seller' | 'buyer', Mandate> = {
  seller: {
    floorOrCeiling: 450, openingOffer: 750, maxConcessionPerRound: 75, walkAwayAt: 6,
    dealbreakers: ['payment before pickup is not received', 'buyer wants delivery paid by seller'],
    allowedShare: ['item_condition', 'pickup_window', 'dimensions', 'original_price_$1,899'],
    neverShare: ['floor', 'ceiling', 'home_address_before_agreement', 'payment_details'],
    secrets: { home_address: '1420 Valencia St Apt 3', payment_details: 'venmo @agent1-demo-7731' },
  },
  buyer: {
    floorOrCeiling: 600, openingOffer: 380, maxConcessionPerRound: 60, walkAwayAt: 6,
    dealbreakers: ['visible stains or pet damage', 'pickup later than next Sunday'],
    allowedShare: ['pickup_window', 'can_pay_on_handoff'],
    neverShare: ['floor', 'ceiling', 'home_address_before_agreement', 'payment_details'],
    secrets: { home_address: '88 King St Unit 1204', card_number: '4242 4242 4242 4242' },
  },
};

for (const file of ['.env.agent1', '.env.agent2']) {
  const env = parse(readFileSync(file));
  const role = env.PROXY_ROLE as 'seller' | 'buyer';
  if (reset && existsSync(env.DB_PATH)) for (const f of [env.DB_PATH, `${env.DB_PATH}-wal`, `${env.DB_PATH}-shm`]) rmSync(f, { force: true });
  const db = openDb(env.DB_PATH);
  const channelPref = (env.CHANNEL_PREF || 'auto') as ChannelPref;
  if (!CHANNEL_PREFS.includes(channelPref)) throw new Error(`${file}: CHANNEL_PREF must be ${CHANNEL_PREFS.join('|')}`);
  db.insert(deals).values({
    id: dealId, role, item: ITEM, stage: 'NEGOTIATING', status: 'active', createdAt: now(), channelPref,
    counterparty: { name: env.COUNTERPARTY_NAME, kind: 'fo', phone: env.COUNTERPARTY_PHONE || undefined, email: env.COUNTERPARTY_EMAIL || undefined },
  }).run();
  db.insert(mandates).values({ dealId, data: MANDATES[role] }).run();
  const reason = role === 'seller'
    ? `Deal created. You are selling: ${ITEM}. ${env.COUNTERPARTY_NAME} (the buyer) will call you; you never place calls. Your Fo is being briefed to negotiate and close live when it answers. Do not contact them now; schedule a follow-up and act on the call transcript when it arrives.`
    : `Deal created. You are buying: ${ITEM}. Call ${env.COUNTERPARTY_NAME} (the seller) now with your opening offer and negotiate to a deal on that call. Only you place calls; the seller never calls you.`;
  db.insert(jobs).values({ dealId, type: 'brief', runAt: now(), payload: {} }).run();
  db.insert(jobs).values({ dealId, type: 'turn', runAt: new Date(Date.now() + 1000).toISOString(), payload: { triggerId: 'kickoff', reason } }).run();
  console.log(`${env.OWNER_NAME} (${role}, channel ${channelPref}) -> ${env.DB_PATH}: seeded ${dealId}`);
  db.$client.close();
}
console.log(`\nDeal ${dealId} ready. Start both proxies; the seller opens.`);
