import type Anthropic from '@anthropic-ai/sdk';

type Tool = Anthropic.Beta.BetaTool;

const channel = { type: 'string', enum: ['text', 'email', 'call'] };

/** Fixed order: the tool list is part of the cached prefix. */
export const TOOLS: Tool[] = [
  {
    name: 'propose',
    description: 'Make an offer or counteroffer (or accept theirs with accept=true) and send it to the counterparty via Fo. Records the offer. Rejected if outside the mandate.',
    input_schema: {
      type: 'object',
      properties: {
        amount: { type: 'number', description: 'Price in USD' },
        terms: { type: 'string', description: 'Short terms, e.g. "pickup this weekend, cash on handoff"' },
        rationale: { type: 'string', description: 'Private reasoning for the audit log; not sent' },
        message: { type: 'string', description: 'The exact message Fo will send, starting with the AI disclosure and including the deal reference' },
        channel,
        accept: { type: 'boolean', description: 'True only when accepting the counterparty\'s exact last offer' },
      },
      required: ['amount', 'terms', 'rationale', 'message', 'channel'],
      additionalProperties: false,
    },
  },
  {
    name: 'fo_act',
    description: 'Have Fo send a message or place a call to a target (non-offer communication: questions, logistics, follow-ups, recaps). Checked for leaks and disclosure before sending.',
    input_schema: {
      type: 'object',
      properties: {
        channel,
        target: { type: 'string', description: 'Phone number or email address' },
        objective: { type: 'string' },
        script: { type: 'string', description: 'Exact message, or for calls the opening line plus talking points. Calls are settled live; never write points that defer ("I\'ll get back to you").' },
        constraints: { type: 'array', items: { type: 'string' } },
        stage: { type: 'string' },
      },
      required: ['channel', 'target', 'objective', 'script', 'constraints', 'stage'],
      additionalProperties: false,
    },
  },
  {
    name: 'brief_fo',
    description: 'Add context to your own Fo\'s standing call-answering instruction (the proxy already briefs it with the item, your price authority and the live-call rules). Use it for things like questions to ask or points to stress.',
    input_schema: {
      type: 'object',
      properties: {
        instructions: { type: 'string' },
      },
      required: ['instructions'],
      additionalProperties: false,
    },
  },
  {
    name: 'request_approval',
    description: 'Ask the owner to approve something. Tier 1 = share address/contact, tier 2 = accept at/near limit or book paid courier, tier 3 = move money/refund. Pauses the deal until decided.',
    input_schema: {
      type: 'object',
      properties: {
        tier: { type: 'integer', enum: [1, 2, 3] },
        summary: { type: 'string' },
        payload: { type: 'object', description: 'Exact parameters being approved, e.g. {"amount": 520} or {"to": "...", "amount": 520, "memo": "..."}' },
      },
      required: ['tier', 'summary', 'payload'],
      additionalProperties: false,
    },
  },
  {
    name: 'ask_owner',
    description: 'Text your owner a short question and keep going; their reply arrives as a new turn and is a trusted instruction. For a decision that must block the deal (accepting a price, final terms), use request_approval instead.',
    input_schema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'One or two sentences, e.g. "Seller will add the sofa for $50 more. Want it?"' },
      },
      required: ['question'],
      additionalProperties: false,
    },
  },
  {
    name: 'schedule_followup',
    description: 'Schedule your next turn for this deal.',
    input_schema: {
      type: 'object',
      properties: {
        inMinutes: { type: 'number' },
        reason: { type: 'string' },
        tactic: { type: 'string' },
      },
      required: ['inMinutes', 'reason', 'tactic'],
      additionalProperties: false,
    },
  },
  {
    name: 'verify',
    description: 'Check the world state for evidence that a stage\'s exit criteria are met (counterparty messages, call results, booking or charge records). Returns passed, observed and evidence quotes.',
    input_schema: {
      type: 'object',
      properties: {
        stage: { type: 'string' },
        expected: { type: 'string', description: 'What must be true, e.g. "Counterparty agreed to $520 with pickup Saturday"' },
      },
      required: ['stage', 'expected'],
      additionalProperties: false,
    },
  },
  {
    name: 'transition',
    description: 'Move the deal to another stage. Requires a passed verify() for the current stage unless moving to ABANDONED.',
    input_schema: {
      type: 'object',
      properties: {
        to: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['to', 'reason'],
      additionalProperties: false,
    },
  },
  {
    name: 'record_commitment',
    description: 'Record a promise someone made (who, what, when).',
    input_schema: {
      type: 'object',
      properties: {
        who: { type: 'string', enum: ['self', 'counterparty', 'courier'] },
        what: { type: 'string' },
        dueAt: { type: 'string', description: 'ISO time or empty' },
      },
      required: ['who', 'what', 'dueAt'],
      additionalProperties: false,
    },
  },
  {
    name: 'resolve_commitment',
    description: 'Mark a commitment kept or broken, with evidence.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        status: { type: 'string', enum: ['kept', 'broken'] },
        evidence: { type: 'string' },
      },
      required: ['id', 'status', 'evidence'],
      additionalProperties: false,
    },
  },
  {
    name: 'escalate_to_human',
    description: 'Stop and ask the owner to decide. Pauses the deal.',
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string' },
        options: { type: 'array', items: { type: 'string' } },
      },
      required: ['reason', 'options'],
      additionalProperties: false,
    },
  },
];
