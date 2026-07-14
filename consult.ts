#!/usr/bin/env bun
// consult.ts — headless one-shot Dexter consult for the Simons trading agent.
// Keys load from this checkout's .env (populated from the 1Password "Agents" vault).
// Default model is GLM 5.2 via OpenRouter (cheap). Override with DEXTER_MODEL.
// Dexter is research evidence, never an order gate. Sanitize every output before
// it reaches Simons' audit/context. See simons portfolio-operator/references/dexter-research-tool.md
import { config } from 'dotenv';
config({ override: true }); // vault .env wins over any stale exported shell key

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

const model = process.env.DEXTER_MODEL ?? 'openrouter:z-ai/glm-5.2';
const maxIterations = Number(process.env.DEXTER_MAX_ITERATIONS ?? '10');
const timeoutMs = Number(process.env.DEXTER_TIMEOUT_MS ?? '180000');
const configuredTools = process.env.DEXTER_TOOL_ALLOWLIST
  ?.split(',')
  .map((name) => name.trim())
  .filter(Boolean);
const toolAllowlist = configuredTools?.length
  ? configuredTools
  : ['sec_filings', 'web_fetch', 'browser'];

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
