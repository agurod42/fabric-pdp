// strategies/llmStrategy.js — LLM strategy wrapper
// Delegates to the global analyze function (callLLM) and returns a plan.

/**
 * Resolve a plan using the LLM-based analyzer.
 * ctx is unused; kept for parity with other strategies.
 */
async function llmStrategy(payload /*, ctx */) {
  return await callLLM(payload);
}

self.llmStrategy = llmStrategy;


