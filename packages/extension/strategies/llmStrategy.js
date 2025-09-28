// LLM strategy wrapper (delegates to global callLLM)

async function llmStrategy(payload /*, ctx */) {
  return await callLLM(payload);
}

self.llmStrategy = llmStrategy;


