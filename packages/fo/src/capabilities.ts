import { anthropic, autoCache, hasApiKey, model } from '@proxydeal/llm';

export const CAPABILITY_KEYS = ['call', 'email', 'text', 'pay', 'status', 'threads', 'thread_read'] as const;
export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];

export interface FoTool {
  name: string;
  description?: string;
  inputSchema: unknown;
}

export interface CapabilityEntry {
  toolName: string | null;
  source: 'rules' | 'model' | 'none';
  /** True when the tool is a general "ask Fo" agent rather than a channel-specific primitive. */
  viaAgent: boolean;
  schema?: unknown;
}
export type CapabilityMap = Record<CapabilityKey, CapabilityEntry>;

// Rules table: first match wins. Name patterns are checked before description patterns.
const RULES: Record<CapabilityKey, { name: RegExp[]; desc: RegExp[] }> = {
  call: { name: [/(^|_)(call|phone|dial)(_|$)/], desc: [/phone call|place a call|dial/i] },
  email: { name: [/(^|_)(email|mail)(_|$)/], desc: [/send (an )?email/i] },
  text: { name: [/(^|_)(sms|text|message)(_|$)/], desc: [/send (a )?(text|sms)/i] },
  pay: { name: [/(^|_)(pay|payment|charge|purchase)(_|$)/], desc: [/payment|purchase|charge/i] },
  status: { name: [/(get_.*reply|status|task)/], desc: [/status|finish|wait.*(reply|task)/i] },
  threads: { name: [/^list_.*(conversation|thread)s?$/], desc: [/list .*conversations/i] },
  thread_read: { name: [/^get_.*(conversation|thread)$/], desc: [/transcript/i] },
};

// Outbound channels need a primitive that takes a destination. A tool like
// start_fo_call (a voice link for the *user*) must not be mistaken for one.
const OUTBOUND: CapabilityKey[] = ['call', 'email', 'text', 'pay'];
function takesDestination(t: FoTool): boolean {
  const props = Object.keys((t.inputSchema as { properties?: object })?.properties ?? {});
  return props.some((p) => /^(to|recipient|phone|number|email|address|payee)/i.test(p));
}

function matchRules(tools: FoTool[], key: CapabilityKey): FoTool | undefined {
  const r = RULES[key];
  const pool = OUTBOUND.includes(key) ? tools.filter(takesDestination) : tools;
  return (
    pool.find((t) => r.name.some((re) => re.test(t.name))) ??
    pool.find((t) => r.desc.some((re) => re.test(t.description ?? '')))
  );
}

/** Tools like ask_fo take free-form requests and can do any channel. */
function findAgentTool(tools: FoTool[]): FoTool | undefined {
  return tools.find((t) => /^ask_|(^|_)ask(_|$)/.test(t.name));
}

async function classifyWithModel(tools: FoTool[], keys: CapabilityKey[]): Promise<Partial<Record<CapabilityKey, string>>> {
  if (!hasApiKey() || keys.length === 0) return {};
  const res = await anthropic().messages.create({
    model: model('cheap'),
    max_tokens: 512,
    cache_control: autoCache(),
    messages: [{
      role: 'user',
      content:
        `Map each capability to the single best MCP tool name, or null if none fits.\n` +
        `Capabilities: ${keys.join(', ')}\n` +
        `(call=place a phone call, email=send email, text=send SMS, pay=move money, ` +
        `status=check progress of a running task, threads=list conversations, thread_read=read one transcript)\n\n` +
        `Tools:\n${tools.map((t) => `- ${t.name}: ${t.description ?? ''}`).join('\n')}\n\n` +
        `Reply with only a JSON object, e.g. {"call":"tool_name","pay":null}.`,
    }],
  });
  const text = res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
  const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  try {
    const parsed = JSON.parse(json) as Record<string, string | null>;
    const names = new Set(tools.map((t) => t.name));
    return Object.fromEntries(
      Object.entries(parsed).filter(([, v]) => typeof v === 'string' && names.has(v)),
    ) as Partial<Record<CapabilityKey, string>>;
  } catch {
    return {};
  }
}

export async function buildCapabilityMap(tools: FoTool[]): Promise<CapabilityMap> {
  const map = {} as CapabilityMap;
  const unmatched: CapabilityKey[] = [];
  const agent = findAgentTool(tools);

  for (const key of CAPABILITY_KEYS) {
    const t = matchRules(tools, key);
    if (t) map[key] = { toolName: t.name, source: 'rules', viaAgent: false, schema: t.inputSchema };
    else unmatched.push(key);
  }

  const fromModel = await classifyWithModel(tools, unmatched);
  for (const key of unmatched) {
    const name = fromModel[key];
    const t = name ? tools.find((x) => x.name === name) : undefined;
    if (t && (!OUTBOUND.includes(key) || t === agent || takesDestination(t)))
      map[key] = { toolName: t.name, source: 'model', viaAgent: t === agent, schema: t.inputSchema };
    else if (agent && OUTBOUND.includes(key))
      map[key] = { toolName: agent.name, source: 'rules', viaAgent: true, schema: agent.inputSchema };
    else map[key] = { toolName: null, source: 'none', viaAgent: false };
  }
  return map;
}
