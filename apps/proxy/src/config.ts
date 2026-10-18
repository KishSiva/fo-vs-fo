import { config as loadEnv } from 'dotenv';
import type { Role } from '@proxydeal/core';

export interface Config {
  proxyId: string;
  role: Role;
  owner: string;
  ownerEmail?: string;
  ownerPhone?: string;
  counterparty: { name: string; email?: string; phone?: string };
  foMcpUrl: string;
  foOauthPort: number;
  port: number;
  dbPath: string;
  mockFo: boolean;
  workerIntervalMs: number;
  /** Multiplies follow-up delays (0.05 = 20x faster for demos). */
  timeScale: number;
  /** The other agent's proxy API. Fo only logs a call on the caller's side, so the caller sends the transcript here. */
  peerUrl?: string;
  /** The owner's own cell (not their Fo's number). Marketplace deals text it for sign-off on final terms. */
  ownerNotifyPhone?: string;
  /** Off unless ALLOW_PAYMENTS=1: Fo never moves real money for a demo. */
  allowPayments: boolean;
  /**
   * FO_AUTO_CONFIRM=1: the owner lets the proxy answer Fo's own "OK to send?" check for messages the
   * agent wrote and the guards passed. Off by default; never applies to payments.
   */
  foAutoConfirm: boolean;
  /** Owner's timezone (IANA, e.g. America/Los_Angeles) so the agent schedules and reports in local time. */
  timezone: string;
  /**
   * Experiment: SHARE_PRIVATE_WITH_FO=1 gives Fo the owner's private preferences (real limit, target, private notes)
   * marked secret, and lets a hand-off plan contain them. Texts to the other side are still leak-checked.
   */
  sharePrivateWithFo: boolean;
  /** How often to ask Fo to quote a group thread (each read is a Fo request, ~30-60s). */
  groupPollMs: number;
  /** How often to check Fo for new texts (each new message starts a Claude turn). */
  inboundPollMs: number;
}

export function loadConfig(argv: string[]): Config {
  const i = argv.indexOf('--env');
  if (i > -1) loadEnv({ path: argv[i + 1], override: true });
  const need = (k: string) => {
    const v = process.env[k];
    if (!v) throw new Error(`${k} is not set`);
    return v;
  };
  const role = need('PROXY_ROLE');
  if (role !== 'seller' && role !== 'buyer') throw new Error('PROXY_ROLE must be seller or buyer');
  return {
    proxyId: need('PROXY_ID'),
    role,
    owner: need('OWNER_NAME'),
    ownerEmail: process.env.OWNER_EMAIL || undefined,
    ownerPhone: process.env.OWNER_PHONE || undefined,
    counterparty: {
      name: need('COUNTERPARTY_NAME'),
      email: process.env.COUNTERPARTY_EMAIL || undefined,
      phone: process.env.COUNTERPARTY_PHONE || undefined,
    },
    foMcpUrl: need('FO_MCP_URL'),
    foOauthPort: Number(process.env.FO_OAUTH_PORT ?? 8765),
    port: Number(need('PORT')),
    dbPath: need('DB_PATH'),
    mockFo: argv.includes('--mock') || process.env.MOCK_FO === '1',
    workerIntervalMs: Number(process.env.WORKER_INTERVAL_MS ?? 15_000),
    timeScale: Number(process.env.TIME_SCALE ?? 1),
    peerUrl: process.env.PEER_PROXY_URL?.replace(/\/$/, '') || undefined,
    ownerNotifyPhone: process.env.OWNER_NOTIFY_PHONE || undefined,
    allowPayments: process.env.ALLOW_PAYMENTS === '1',
    foAutoConfirm: process.env.FO_AUTO_CONFIRM === '1',
    timezone: process.env.OWNER_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone,
    sharePrivateWithFo: process.env.SHARE_PRIVATE_WITH_FO === '1',
    groupPollMs: Number(process.env.GROUP_POLL_MS ?? 45_000),
    inboundPollMs: Number(process.env.INBOUND_POLL_MS ?? 30_000),
  };
}
