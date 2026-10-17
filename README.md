# Fo vs Fo: ProxyDeal

GSD Hackathon (Wajo × Anthropic) project.

Two people each have a **Proxy**: a Claude-powered agent that negotiates a used-item sale for them by acting through their own Wajo **Fo** assistant (texts, email, calls). The two Proxies negotiate with each other through their Fos, while the rules that matter (price limits, keeping private info private, approvals before money moves, verification before a stage completes) are enforced in code, not just in the prompt.

```
Agent 1 Proxy ──ask_fo──▶ Fo 1 ──text/call──▶ Fo 2 ◀──list/get conversations── Agent 2 Proxy
   (seller)                                                                       (buyer)
      └──────────── dashboard (timeline, approvals, scorecard) ────────────────────┘
```

## Prerequisites

- Node 20+
- pnpm 9 (`npm i -g pnpm@9`)
- An Anthropic API key
- For real (non-mock) runs: two Wajo accounts with Fo, one per agent

## 1. Install

```bash
git clone https://github.com/KishSiva/fo-vs-fo.git
cd fo-vs-fo
pnpm install
```

## 2. Configure the two agents

Each Proxy reads its own env file. Copy the template once per agent:

```bash
cp .env.example .env.agent1
cp .env.example .env.agent2
```

Fill them in. The two files mirror each other: each agent's `OWNER_*` contact is the other agent's `COUNTERPARTY_*`.

| Variable | `.env.agent1` (seller) | `.env.agent2` (buyer) |
|---|---|---|
| `ANTHROPIC_API_KEY` | your key | your key |
| `PROXY_ID` | `agent1` | `agent2` |
| `PROXY_ROLE` | `seller` | `buyer` |
| `OWNER_NAME` | `Ryan` | `Muhammed` |
| `OWNER_EMAIL` / `OWNER_PHONE` | Fo 1's email / number | Fo 2's email / number |
| `COUNTERPARTY_NAME` | `Muhammed` | `Ryan` |
| `COUNTERPARTY_EMAIL` / `COUNTERPARTY_PHONE` | Fo 2's email / number | Fo 1's email / number |
| `PORT` | `4001` | `4002` |
| `DB_PATH` | `./data/agent1.db` | `./data/agent2.db` |
| `FO_OAUTH_PORT` | `8765` | `8766` |

Leave `FO_MCP_URL` and the `MODEL_*` values as they are in the template. Model IDs are read only from these variables.

The `.env.agent*` files are gitignored. Don't commit them.

Optional variables:

| Variable | Default | Purpose |
|---|---|---|
| `MOCK_FO` | unset | Set to `1` to use the offline mock Fo instead of the real one |
| `TIME_SCALE` | `1` | Multiplies follow-up delays (`0.01` = 100x faster) |
| `WORKER_INTERVAL_MS` | `15000` | How often the job worker checks for due jobs |
| `LOG_LEVEL` | `info` | Log verbosity (pino) |
| `PEER_PROXY_URL` | unset | The other agent's proxy (`http://localhost:4002` in `.env.agent1`, `:4001` in `.env.agent2`). Fo only logs a call on the caller's account, so the caller's proxy sends the transcript here and both agents get it |
| `CHANNEL_PREF` | `auto` | Channel for deals created by `pnpm seed`: `auto` (the agent picks text or call), `text` or `call`. Change it per deal on the dashboard |

## 3a. Quick start: offline (no Fo accounts needed)

This runs both Proxies against a mock Fo, which passes messages through a shared local SQLite file. Claude still runs for real, so the API key is required.

```bash
pnpm seed --reset      # creates the couch deal in both DBs; the seller opens
pnpm mock              # both proxies, mock Fo, 100x faster follow-ups
pnpm dashboard         # in a second terminal: http://localhost:5173
```

In mock mode a message reaches the other agent only if `COUNTERPARTY_PHONE` in one file exactly matches `OWNER_PHONE` in the other.

## 3b. Real run (through Fo)

**This sends real texts and can place real calls from your Fo.**

1. **Sign each agent in to its Wajo account.** This also lists Fo's tools and saves the capability map to `config/fo-capabilities.<id>.json`:

   ```bash
   pnpm discover:fo --env .env.agent1
   pnpm discover:fo --env .env.agent2
   ```

   Each command prints a sign-in link. Open it **in a browser on the same machine**, because it redirects back to `localhost:8765` or `localhost:8766`, and sign in with that agent's Wajo account. Tokens are saved in `.fo-auth/` (gitignored). The script finishes with `Auth check: OK`.

2. **Seed the deal and start everything.** Use a separate terminal for each command:

   ```bash
   pnpm seed --reset
   pnpm proxy:1
   pnpm proxy:2
   pnpm dashboard
   ```

3. Open http://localhost:5173 and use the selector in the top bar to switch between the two agents. It shows each proxy's `OWNER_NAME`.

## Using the dashboard

- **New deal:** describe a scenario in plain words (item, each side's opening and limit, dealbreakers, private facts). Claude turns it into both agents' private mandates; you review them, pick the channel, and create. Each proxy receives only its own side.
- **Deal page:** the live event timeline with every model turn, Fo action, guard block, approval and verification, plus an offers chart, commitments, and controls to nudge, pause, resume or abandon the deal.
- **Approvals:** one-tap approve or deny. Tier 3 (moving money) always needs a person.
- **Replay:** replays the timeline at 20x speed, for recording the demo video.

Each Proxy also serves a JSON API on its port, for example `curl localhost:4001/api/health` or `curl localhost:4001/api/deals`.

## Other commands

```bash
pnpm test                               # trust-by-design unit tests (vitest)
pnpm typecheck                          # TypeScript across the monorepo
pnpm cache:check                        # verify prompt caching against the real API
pnpm seed --deal PD-DEMO01              # seed a deal with a fixed ID (without --reset, existing DBs are kept)
pnpm exec tsx apps/proxy/src/main.ts --env .env.agent1 --once   # run due jobs once, then exit (debugging)
```

Stopping a Proxy and starting it again is safe. Deal state and scheduled jobs live in SQLite, and any job left running is put back in the queue on boot.

## Prompt caching

Every Claude API call is set up for prompt caching (`packages/llm/src/cache.ts`):

- **Orchestrator (Opus):** tools, then the shared instructions (breakpoint), then the deal mandate (breakpoint). Both breakpoints use a **1-hour TTL**, because proxy turns are often more than 5 minutes apart. The growing conversation uses top-level automatic caching. Each proxy warms the cache on boot with a `max_tokens: 0` request, then re-warms every 55 minutes.
- **Haiku checks** (leak check, inbound extraction, verifier): stable instructions go first in a cached `system` block and the unique content goes last. The verifier also caches its evidence block, which only grows. Prompts under the 512-token minimum aren't cached; the API skips them without an error.
- **Check it:** `pnpm cache:check` sends the prefix twice; the second call should show `read=` greater than 0. Live hit rates per route are in `curl localhost:4001/api/health` under `promptCache`.
- **TTL:** set `PROMPT_CACHE_TTL=5m` to use the 5-minute TTL instead.

## Repo layout

```
apps/proxy        orchestrator service (run once per agent): Claude tool loop, guards, job worker, Fastify API
apps/dashboard    React + Vite dashboard
packages/core     deal state machine, mandate rules, SQLite schema (Drizzle)
packages/fo       Fo MCP client + OAuth, capability map, real and mock adapters
packages/llm      Claude client, prompts, tool definitions, outbound guards
packages/verify   evidence-based verifier
scripts           discover-fo.ts, seed-deal.ts
tests             unit tests
```

## Troubleshooting

- **The sign-in link expired:** links last 5 minutes. Re-run `pnpm discover:fo --env .env.agentN`.
- **The dashboard says "Proxy offline":** that Proxy isn't running, or its `PORT` doesn't match the dashboard's selector. You can override the selector list with `VITE_PROXIES` in `apps/dashboard/.env`.
- **`better-sqlite3` crashes with a segfault:** this project pins v11 for Node 20. Run `pnpm install` again rather than upgrading the package.
- **To start over:** run `pnpm seed --reset`. It deletes both agents' DBs and creates a fresh deal.
