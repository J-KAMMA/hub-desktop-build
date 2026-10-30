// DSH owns the agent loop; Hub owns every tool implementation and approval.
// Deliberately compose only the in-memory kernel. No CLI profiles, filesystem,
// shell, credentials, settings, hooks, packages or persistence are auto-loaded.
import { Context } from "@deepseek-ai/cordis";
import { randomUUID } from "node:crypto";
import Agents from "@deepseek-ai/dsh-agent";
import AgentLoop from "@deepseek-ai/dsh-agent-loop";
import Llm, { createUserMessage } from "@deepseek-ai/dsh-llm";
import Sessions from "@deepseek-ai/dsh-session";
import Projections from "@deepseek-ai/dsh-session-projection";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import Tools from "@deepseek-ai/dsh-tools";
import { validateGeneration } from "../pi-sidecar/generation.mjs";

export async function createDshSession({ model, adapter, tools, systemPrompt, onEvent, sessionId = `hub-${randomUUID()}`, seed, generation }) {
  const profile = generation === undefined ? undefined : validateGeneration(generation, model);
  const ctx = new Context();
  try {
    for (const [plugin, config] of [
      [Llm], [Sessions], [Projections],
      [SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false, personaPrefix: systemPrompt }],
      [Tools], [Agents], [AgentLoop, { agents: [], maxParallelToolCalls: 1 }],
    ]) await ctx.plugin(plugin, config).await();
    ctx.llm.registerAdapter([model.provider], adapter);
    for (const tool of tools) ctx.tools.register({
      name: tool.name, description: tool.description, parameters: tool.parameters,
      output: { schema: {}, render: (_args, value) => value.content },
      execute: (args, exec) => tool.execute(exec.id, args, exec.signal),
    });
    const handle = await ctx.agents.create({ sessionId, seed,
      agentOptions: { provider: model.provider, model: model.id, maxTokens: profile?.maxTokens ?? model.maxTokens,
        ...(profile && profile.reasoning !== "off" ? { reasoningEffort: profile.reasoning } : {}) },
      ...(profile ? { setup: (agentCtx) => {
        agentCtx.on("agent/request", async (_payload, next) => {
          const { reasoningEffort: _inherited, ...config } = await next();
          return { ...config, temperature: profile.temperature, maxTokens: profile.maxTokens,
            ...(profile.reasoning !== "off" ? { reasoningEffort: profile.reasoning } : {}) };
        });
      } } : {}) });
    const { agent } = handle;
    ctx.on("session/event", (session, event) => {
      if (session === agent.session) onEvent?.(event, session);
    });
    return {
      async prompt(text) {
        agent.followup(createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } }));
        await agent.whenIdle();
        return agent.session;
      },
      abort: () => agent.cancel(),
      dispose: async () => { await handle.dispose(); await ctx.fiber.dispose(); },
    };
  } catch (error) {
    await ctx.fiber.dispose();
    throw error;
  }
}
