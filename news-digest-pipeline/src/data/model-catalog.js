// Model catalog with pricing.
//
// Prices are expressed in USD per 1,000,000 (1M) tokens and reflect the
// "base" rates — no prompt caching, no batch discounts.
//
// Sources:
//   - Anthropic: https://claude.com/pricing
//   - OpenAI:    https://developers.openai.com/api/docs/pricing
// Verified: 2026-05-31
//
// This is a hand-maintained reference. Update ids/labels/pricing here as the
// vendors change their lineups; everything else reads from this single source.

export const MODEL_CATALOG = {
  anthropic: [
    { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', pricing: { input: 5, output: 25 } },
    { id: 'claude-opus-4-7', label: 'Claude Opus 4.7', pricing: { input: 5, output: 25 } },
    { id: 'claude-opus-4-6', label: 'Claude Opus 4.6', pricing: { input: 5, output: 25 } },
    { id: 'claude-opus-4-5', label: 'Claude Opus 4.5', pricing: { input: 5, output: 25 } },
    { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', pricing: { input: 3, output: 15 } },
    { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', pricing: { input: 3, output: 15 } },
    { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', pricing: { input: 1, output: 5 } },
  ],
  openai: [
    { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', pricing: { input: 2.5, output: 15 } },
    { id: 'gpt-5.5', label: 'GPT-5.5', pricing: { input: 5, output: 30 } },
    { id: 'gpt-5.5-pro', label: 'GPT-5.5 Pro', pricing: { input: 30, output: 180 } },
    { id: 'gpt-5.4', label: 'GPT-5.4', pricing: { input: 2.5, output: 15 } },
    { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini', pricing: { input: 0.75, output: 4.5 } },
    { id: 'gpt-5.4-nano', label: 'GPT-5.4 Nano', pricing: { input: 0.2, output: 1.25 } },
    { id: 'gpt-5.4-pro', label: 'GPT-5.4 Pro', pricing: { input: 30, output: 180 } },
    { id: 'o3', label: 'o3', pricing: { input: 2, output: 8 } },
    { id: 'gpt-4.1-nano', label: 'GPT-4.1 Nano', pricing: { input: 0.1, output: 0.4 } },
  ],
};

/**
 * Look up the base pricing for a model id across all vendors.
 *
 * @param {string} modelId
 * @returns {{input:number, output:number}|null} pricing per 1M tokens, or null
 *   if the model is not in the catalog.
 */
export function priceFor(modelId) {
  if (!modelId) return null;
  for (const vendor of Object.keys(MODEL_CATALOG)) {
    const found = MODEL_CATALOG[vendor].find((m) => m.id === modelId);
    if (found && found.pricing) {
      return { input: found.pricing.input, output: found.pricing.output };
    }
  }
  return null;
}
