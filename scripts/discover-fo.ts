/**
 * pnpm discover:fo --env .env.alice
 * Connects to FO_MCP_URL, lists every tool + schema, builds the capability map,
 * and persists it to config/fo-capabilities.<role>.json.
 */
import { config } from 'dotenv';
import { mkdirSync, writeFileSync } from 'node:fs';
import { connectFo, buildCapabilityMap, CAPABILITY_KEYS } from '@proxydeal/fo';

const envIdx = process.argv.indexOf('--env');
const envFile = envIdx > -1 ? process.argv[envIdx + 1] : '.env';
config({ path: envFile, override: true });

const need = (k: string) => {
  const v = process.env[k];
  if (!v) { console.error(`${k} missing in ${envFile}`); process.exit(1); }
  return v;
};

const role = need('PROXY_ROLE');
const owner = need('OWNER_NAME');
const client = await connectFo({
  url: need('FO_MCP_URL'),
  role,
  ownerName: owner,
  callbackPort: Number(process.env.FO_OAUTH_PORT ?? 8765),
});

const info = client.serverVersion();
const { tools } = await client.listTools();
console.log(`\n=== Fo MCP for ${owner} (${role}) — server ${info?.name}@${info?.version} — ${tools.length} tools ===\n`);
for (const t of tools) {
  console.log(`• ${t.name}\n  ${(t.description ?? '').split('\n')[0]}`);
  console.log(`  schema: ${JSON.stringify(t.inputSchema)}\n`);
}

const map = await buildCapabilityMap(tools);
console.log('=== Capability map ===');
for (const k of CAPABILITY_KEYS) {
  const e = map[k];
  console.log(`  ${k.padEnd(8)} -> ${e.toolName ?? '(none)'}${e.viaAgent ? '  [via agent request]' : ''}  (${e.source})`);
}

// Confirm authenticated access with a read-only call (never ask_fo: that acts in the real world).
let authCheck: { ok: boolean; detail: string } = { ok: false, detail: 'threads tool not found' };
if (map.threads.toolName) {
  const r = await client.callTool(map.threads.toolName, {});
  const text = (r.content as { type: string; text?: string }[]).map((c) => c.text ?? '').join('');
  authCheck = r.isError ? { ok: false, detail: text.slice(0, 200) } : { ok: true, detail: `${map.threads.toolName} returned ${text.length} bytes` };
}
console.log(`\nAuth check: ${authCheck.ok ? 'OK' : 'FAILED'} — ${authCheck.detail}`);

mkdirSync('config', { recursive: true });
const out = `config/fo-capabilities.${role}.json`;
writeFileSync(out, JSON.stringify({ discoveredAt: new Date().toISOString(), owner, server: info, tools, map, authCheck }, null, 2));
console.log(`\nSaved ${out}`);
await client.close();
