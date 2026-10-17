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
  };
}
