# @proxydeal/dashboard

Owner/judge dashboard for ProxyDeal. React 18 + Vite + TanStack Query (3s polling) + Tailwind v4 + Recharts.

```bash
pnpm --filter @proxydeal/dashboard dev        # http://localhost:5173
pnpm --filter @proxydeal/dashboard build
pnpm --filter @proxydeal/dashboard typecheck
```

## Proxies

The top-bar selector switches between proxy APIs (choice persisted in localStorage).
Defaults: Agent 1 (seller) `http://localhost:4001`, Agent 2 (buyer) `http://localhost:4002`.
Override with `VITE_PROXIES` (see `.env.example`):

```
VITE_PROXIES=[{"name":"Agent 1","url":"http://localhost:4001"},{"name":"Agent 2","url":"http://localhost:4002"}]
```

The browser calls the proxies directly, so the proxy API must send CORS headers
(`Access-Control-Allow-Origin` for `http://localhost:5173`, and allow `Content-Type` for POSTs).

## Pages

- `/` deal list (auto-opens the deal if there is only one)
- `/deals/:id` header + stage strip, event timeline (filters, auto-scroll, **Replay**), offers chart, commitments, verifications, owner controls
- `/approvals` pending approvals with Approve / Deny, tier badge (tier 3 = money), flattened payload + payload hash
- `/scorecard` eval runs table + summary (leaks total, pass rates)

**Replay** (timeline header) replays the loaded events from the start at 20x real time,
with each gap capped at 1.5s. The header stage, offers chart and verifications follow the replay cursor.
Press **Live** to go back. Handy for recording the demo video.

If a proxy is unreachable, pages show "Proxy offline" and polling continues until it comes back.

## Layout

```
src/lib/        api.ts (queries/mutations), proxy.tsx (selector context), replay.ts, types.ts, utils.ts
src/components/ Layout, Timeline, EventItem (per-kind renderers), OffersChart, DealHeader, common, ui/*
src/pages/      DealList, DealDetail, Approvals, Scorecard
```
