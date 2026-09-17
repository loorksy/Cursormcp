import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  createAgent,
  createRun,
  enrichAgent,
  getAgent,
  listAgents,
  listModels,
  listRepositories,
} from "./cursor-api.js";
import { getSetting, log, logRequest } from "./lib.js";
import { registerMemoryMcpTools } from "./memory-mcp.js";
import { registerV2McpTools } from "./mcp-v2.js";
import { resolveActorFromRequest, runWithActor } from "./memory.js";

const transports = new Map();

function jsonResult(data) {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

function errorResult(err) {
  const payload = {
    error: err.message,
    status: err.status || null,
    body: err.body || null,
  };
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

export function createBridgeMcpServer() {
  const server = new McpServer(
    {
      name: "mcp-agents-bridge",
      version: "1.1.0",
    },
    {
      capabilities: { logging: {} },
    },
  );

  server.registerTool(
    "create_agent",
    {
      title: "Create Cursor cloud agent",
      description: "Launch a new Cursor cloud agent on a GitHub repository with a text prompt.",
      inputSchema: {
        prompt: z.string().describe("Instruction text for the agent"),
        repository: z
          .string()
          .describe("GitHub repository URL, e.g. https://github.com/org/repo")
          .optional(),
        ref: z.string().describe("Starting branch or commit SHA").optional(),
        model: z.string().describe("Model id from list_models").optional(),
        autoCreatePR: z.boolean().describe("Open a pull request when the run finishes").optional(),
        name: z.string().describe("Optional display name").optional(),
      },
    },
    async (args) => {
      try {
        const defaultRepos = JSON.parse(getSetting("default_repos") || "[]");
        const repository = args.repository || defaultRepos[0] || undefined;
        const ref = args.ref || getSetting("default_ref") || undefined;
        const model = args.model || getSetting("default_model") || undefined;
        const autoCreatePR =
          args.autoCreatePR ?? getSetting("auto_create_pr") === "true";
        const created = await createAgent({
          prompt: args.prompt,
          repository,
          ref,
          model,
          autoCreatePR,
          name: args.name,
        });
        logRequest({
          source: "mcp",
          tool: "create_agent",
          status: 200,
          detail: created?.agent?.id || "",
        });
        return jsonResult(created);
      } catch (err) {
        logRequest({ source: "mcp", tool: "create_agent", status: err.status || 500, detail: err.message });
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "get_agent",
    {
      title: "Get agent status",
      description: "Fetch status, result text, git branch, and PR link for an existing cloud agent.",
      inputSchema: {
        agentId: z.string().describe("Cloud agent id (bc-...)"),
      },
    },
    async ({ agentId }) => {
      try {
        const agent = await getAgent(agentId);
        const enriched = await enrichAgent(agent);
        logRequest({ source: "mcp", tool: "get_agent", status: 200, detail: agentId });
        return jsonResult(enriched);
      } catch (err) {
        logRequest({ source: "mcp", tool: "get_agent", status: err.status || 500, detail: err.message });
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "followup_agent",
    {
      title: "Send follow-up instruction",
      description: "Send a follow-up prompt to a running or idle Cursor cloud agent.",
      inputSchema: {
        agentId: z.string().describe("Cloud agent id (bc-...)"),
        prompt: z.string().describe("Follow-up instruction"),
        mode: z.enum(["agent", "plan"]).optional(),
      },
    },
    async ({ agentId, prompt, mode }) => {
      try {
        const run = await createRun(agentId, { prompt, mode });
        logRequest({ source: "mcp", tool: "followup_agent", status: 200, detail: agentId });
        return jsonResult(run);
      } catch (err) {
        logRequest({ source: "mcp", tool: "followup_agent", status: err.status || 500, detail: err.message });
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "list_repos",
    {
      title: "List GitHub repositories",
      description: "List GitHub repositories available to the configured Cursor API key.",
    },
    async () => {
      try {
        const repos = await listRepositories();
        logRequest({ source: "mcp", tool: "list_repos", status: 200, detail: "" });
        return jsonResult(repos);
      } catch (err) {
        logRequest({ source: "mcp", tool: "list_repos", status: err.status || 500, detail: err.message });
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "list_models",
    {
      title: "List available models",
      description: "List models that can be passed when creating a Cursor cloud agent.",
    },
    async () => {
      try {
        const models = await listModels();
        logRequest({ source: "mcp", tool: "list_models", status: 200, detail: "" });
        return jsonResult(models);
      } catch (err) {
        logRequest({ source: "mcp", tool: "list_models", status: err.status || 500, detail: err.message });
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "list_agents",
    {
      title: "List cloud agents",
      description: "List recent Cursor cloud agents and a simplified running/finished/failed status.",
      inputSchema: {
        limit: z.number().int().min(1).max(50).optional(),
      },
    },
    async ({ limit }) => {
      try {
        const listed = await listAgents({ limit: limit || 20 });
        const items = [];
        for (const agent of listed.items || []) {
          items.push(await enrichAgent(agent));
        }
        logRequest({ source: "mcp", tool: "list_agents", status: 200, detail: String(items.length) });
        return jsonResult({ items, nextCursor: listed.nextCursor || null });
      } catch (err) {
        logRequest({ source: "mcp", tool: "list_agents", status: err.status || 500, detail: err.message });
        return errorResult(err);
      }
    },
  );

  registerMemoryMcpTools(server);
  registerV2McpTools(server);

  return server;
}

export function mcpSessionCount() {
  return transports.size;
}

export async function handleMcpPost(req, res) {
  return runWithActor(resolveActorFromRequest(req), () => handleMcpPostInner(req, res));
}

async function handleMcpPostInner(req, res) {
  const sessionId = req.headers["mcp-session-id"];
  try {
    if (sessionId && transports.has(sessionId)) {
      await transports.get(sessionId).handleRequest(req, res, req.body);
      return;
    }
    if (!sessionId && isInitializeRequest(req.body)) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports.set(id, transport);
          log("info", "mcp_session_init", { session: id.slice(0, 8) });
        },
      });
      transport.onclose = () => {
        const id = transport.sessionId;
        if (id) transports.delete(id);
      };
      const server = createBridgeMcpServer();
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }
    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Bad Request: no valid MCP session" },
      id: null,
    });
  } catch (err) {
    log("error", "mcp_post_error", { error: err.message });
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
}

export async function handleMcpSession(req, res) {
  return runWithActor(resolveActorFromRequest(req), () => handleMcpSessionInner(req, res));
}

async function handleMcpSessionInner(req, res) {
  const sessionId = req.headers["mcp-session-id"];
  if (!sessionId || !transports.has(sessionId)) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }
  await transports.get(sessionId).handleRequest(req, res);
}
