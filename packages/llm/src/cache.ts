/**
 * Prompt caching policy (see platform.claude.com prompt caching docs):
 * - Stable prefixes (tools + system) get explicit breakpoints with a 1-hour TTL,
 *   because proxy turns are usually 5-60+ minutes apart.
 * - The growing conversation tail uses top-level automatic caching (5-minute TTL,
 *   which may follow 1-hour entries; longer TTLs must come first).
 * - Prompts that end in unique content put the breakpoint at the end of the shared
 *   part instead of using automatic caching.
 */
export type CacheTtl = '5m' | '1h';

const PREFIX_TTL: CacheTtl = process.env.PROMPT_CACHE_TTL === '5m' ? '5m' : '1h';

/** Explicit breakpoint for a stable prefix block (system prompt, shared evidence). */
export const prefixCache = () => ({ type: 'ephemeral' as const, ttl: PREFIX_TTL });

/** Top-level automatic caching for the growing message history. */
export const autoCache = () => ({ type: 'ephemeral' as const });

interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

interface RouteStats { requests: number; input: number; cacheRead: number; cacheWrite: number; output: number }
const stats = new Map<string, RouteStats>();

/** Record usage per route so /api/health can show whether caching is working. */
export function trackUsage(route: string, u: Usage) {
  const s = stats.get(route) ?? { requests: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  s.requests++;
  s.input += u.input_tokens;
  s.cacheRead += u.cache_read_input_tokens ?? 0;
  s.cacheWrite += u.cache_creation_input_tokens ?? 0;
  s.output += u.output_tokens;
  stats.set(route, s);
}

export function cacheStats() {
  return Object.fromEntries([...stats].map(([route, s]) => {
    const totalIn = s.input + s.cacheRead + s.cacheWrite;
    return [route, { ...s, hitRate: totalIn ? Math.round((s.cacheRead / totalIn) * 1000) / 10 : 0 }];
  }));
}

export const cacheTtl = () => PREFIX_TTL;
