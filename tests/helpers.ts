export { checkDisclosure, redactPrivate } from '../packages/llm/src/guards.js';
import { renderRequest } from '../packages/fo/src/adapter.js';

export const renderRequestForTest = () => renderRequest({
  channel: 'text', to: '+16464646625', objective: 'Offer $600', dealId: 'PD-TEST',
  script: "Hi, this is Agent 1's AI assistant. I can do $600 (ref PD-TEST).", constraints: [], mustDisclose: true,
});
