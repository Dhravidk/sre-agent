import { defineAgent } from 'eve';

// One persistent Eve session per incident, dispatched by the database worker.
export default defineAgent({
  model: process.env.SRE_MODEL || 'openai/gpt-6-luna-fast',
  defaultTools: false,
  limits: {
    maxInputTokensPerSession: 100000,
    maxOutputTokensPerSession: 12000,
    maxTokenCostUsdPerSession: 2,
    sessionTimeoutMs: 24 * 60 * 60 * 1000,
  },
});
