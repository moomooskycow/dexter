#!/usr/bin/env bun
// consult.ts — headless one-shot Dexter consult for the Simons trading agent.
// Provider calls route through Mint by default, so Dexter receives placeholders
// instead of credentials. Set DEXTER_USE_MINT=false only for explicit fallback.
// Default model is GPT-5.4 Mini via OpenAI. Override with DEXTER_MODEL.
// Dexter is research evidence, never an order gate. Sanitize every output before
// it reaches Simons' audit/context. See simons portfolio-operator/references/dexter-research-tool.md
import { config } from 'dotenv';

const useMint = process.env.DEXTER_USE_MINT !== 'false';
const mintBaseUrl = process.env.MINT_BASE_URL ?? 'http://mint.tail5f5eb4.ts.net:4949';

if (useMint) {
  // Placeholders are not credentials. Mint swaps the real values only inside
  // its broker process, so Dexter never reads the raw provider keys.
  process.env.OPENAI_API_KEY = '__mint.openai.default__';
  process.env.OPENAI_BASE_URL = `${mintBaseUrl}/proxy/https/api.openai.com/v1`;
  process.env.OPENROUTER_API_KEY = '__mint.openrouter.default__';
  process.env.OPENROUTER_BASE_URL = `${mintBaseUrl}/proxy/https/openrouter.ai/api/v1`;
  process.env.EXASEARCH_API_KEY = '__mint.exa.default__';
  process.env.EXA_BASE_URL = `${mintBaseUrl}/proxy/https/api.exa.ai`;
} else {
  config({ override: true });
}

// SEC asks automated clients to identify a contact. Reuse the developer's
// local git identity without printing or persisting it in Dexter output.
if (!process.env.SEC_USER_AGENT) {
  const gitEmail = Bun.spawnSync(['git', 'config', 'user.email']).stdout.toString().trim();
  if (gitEmail.includes('@')) process.env.SEC_USER_AGENT = `Dexter research ${gitEmail}`;
}

const question = process.argv.slice(2).join(' ').trim();
if (!question) {
  console.error('usage: bun run consult.ts "<research question>"');
  process.exit(2);
}

const model = process.env.DEXTER_MODEL ?? 'gpt-5.4-mini';
const maxIterations = Number(process.env.DEXTER_MAX_ITERATIONS ?? '4');
const timeoutMs = Number(process.env.DEXTER_TIMEOUT_MS ?? '180000');
const configuredTools = process.env.DEXTER_TOOL_ALLOWLIST
  ?.split(',')
  .map((name) => name.trim())
  .filter(Boolean);
const toolAllowlist = configuredTools?.length
  ? configuredTools
  : ['sec_filings', 'web_search', 'web_fetch', 'browser', 'read_file'];

async function readOpenRouterUsage(): Promise<number | null> {
  if (!useMint || !model.startsWith('openrouter:')) return null;
  try {
    const response = await fetch(`${process.env.OPENROUTER_BASE_URL}/key`, {
      headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` },
    });
    if (!response.ok) return null;
    const payload = await response.json() as { data?: { usage_daily?: number } };
    return typeof payload.data?.usage_daily === 'number' ? payload.data.usage_daily : null;
  } catch {
    return null;
  }
}

if (!Number.isInteger(maxIterations) || maxIterations < 1) {
  console.error('DEXTER_MAX_ITERATIONS must be a positive integer');
  process.exit(2);
}
if (!Number.isFinite(timeoutMs) || timeoutMs < 1000) {
  console.error('DEXTER_TIMEOUT_MS must be at least 1000');
  process.exit(2);
}

const abortController = new AbortController();
const timeout = setTimeout(() => abortController.abort(), timeoutMs);
const startedAt = Date.now();
const usageBefore = await readOpenRouterUsage();
let tokenUsage: { inputTokens: number; outputTokens: number; totalTokens: number } | undefined;

const openRouterPricesPerToken: Record<string, { input: number; output: number }> = {
  'gpt-5.4-mini': { input: 0.75 / 1_000_000, output: 4.5 / 1_000_000 },
  'openrouter:openai/gpt-5.4-mini': { input: 0.75 / 1_000_000, output: 4.5 / 1_000_000 },
  'openrouter:z-ai/glm-5.2': { input: 0.91 / 1_000_000, output: 2.86 / 1_000_000 },
  'openrouter:deepseek/deepseek-v4-pro': { input: 0.435 / 1_000_000, output: 0.87 / 1_000_000 },
  'openrouter:deepseek/deepseek-v4-flash': { input: 0.09 / 1_000_000, output: 0.18 / 1_000_000 },
};

try {
  const { Agent } = await import('./src/agent/agent.js'); // imported after env loads
  const agent = await Agent.create({
    model,
    maxIterations,
    signal: abortController.signal,
    channel: 'headless',
    memoryEnabled: false,
    toolAllowlist,
  });
  let answer = '';
  for await (const event of agent.run(question)) {
    switch (event.type) {
      case 'tool_start':
        console.error(`[dexter] ${event.tool} started`);
        break;
      case 'tool_end':
        console.error(`[dexter] ${event.tool} finished in ${event.duration}ms`);
        break;
      case 'tool_error':
        console.error(`[dexter] ${event.tool} failed: ${event.error}`);
        break;
      case 'done':
        answer = event.answer ?? answer;
        tokenUsage = event.tokenUsage;
        console.error(`[dexter] completed ${event.iterations} iterations in ${event.totalTime}ms`);
        break;
      default:
        break;
    }
  }
  if (abortController.signal.aborted) {
    console.error(`dexter consult timed out after ${Date.now() - startedAt}ms`);
    process.exit(124);
  }
  const usageAfter = await readOpenRouterUsage();
  const prices = openRouterPricesPerToken[model];
  if (tokenUsage && prices) {
    const estimatedCost = tokenUsage.inputTokens * prices.input + tokenUsage.outputTokens * prices.output;
    console.error(
      `[dexter] tokens ${tokenUsage.inputTokens} in / ${tokenUsage.outputTokens} out; model estimate $${estimatedCost.toFixed(6)}`,
    );
  }
  if (usageBefore !== null && usageAfter !== null) {
    const delta = Math.max(0, usageAfter - usageBefore);
    console.error(`[dexter] OpenRouter account delta $${delta.toFixed(6)} (shared-key estimate)`);
  }
  process.stdout.write((answer.trim() || '(no answer produced)') + '\n');
  clearTimeout(timeout);
  process.exit(0);
} catch (err) {
  clearTimeout(timeout);
  const elapsed = Date.now() - startedAt;
  if (abortController.signal.aborted) {
    console.error(`dexter consult timed out after ${elapsed}ms`);
    process.exit(124);
  }
  console.error('dexter consult failed:', err instanceof Error ? err.message : err);
  process.exit(1);
}
