import Anthropic from '@anthropic-ai/sdk';

export type ModelRole = 'orchestrator' | 'negotiate' | 'cheap';

const MODEL_ENV: Record<ModelRole, string> = {
  orchestrator: 'MODEL_ORCHESTRATOR',
  negotiate: 'MODEL_NEGOTIATE',
  cheap: 'MODEL_CHEAP',
};

/** Model IDs are always read from env, never hardcoded. */
export function model(role: ModelRole): string {
  const id = process.env[MODEL_ENV[role]];
  if (!id) throw new Error(`${MODEL_ENV[role]} is not set`);
  return id;
}

let client: Anthropic | undefined;
export function anthropic(): Anthropic {
  client ??= new Anthropic();
  return client;
}

export function hasApiKey(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}
