import { z } from "zod";
import { logRequest } from "./lib.js";
import { currentActor } from "./memory.js";
import {
  createProject,
  getProjectFull,
  listProjects,
  updateProject,
  addTask,
  getTask,
  updateTaskStatus,
  proposeTaskDone,
  latestPlanPrompt,
  savePlanPrompt,
} from "./memory.js";
import {
  launchTrackedAgent,
  stopTrackedAgent,
  orchestrateProject,
} from "./orchestrator.js";
import { getAgent, listAgents, enrichAgent, createRun } from "./cursor-api.js";
import { getAgentRecord, listAgentRecords, listRunRecords } from "./agents-store.js";
import { listEvents, getEvent, retryEvent } from "./events.js";
import { latestVerification, latestBuildStatus, verifyAgentCompletion } from "./verification.js";
import { inspectPullRequest, createPullRequest, getPullRequest } from "./github.js";
import { telegramService } from "./telegram-service.js";
import { addPrLink } from "./memory.js";

function jsonResult(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function wrap(tool, fn) {
  return async (args = {}) => {
    try {
      const data = await fn(args);
      logRequest({ source: "mcp", tool, status: 200, detail: currentActor() });
      return data;
    } catch (err) {
      logRequest({ source: "mcp", tool, status: err.status || 500, detail: err.message });
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify({ error: err.message }, null, 2) }],
      };
    }
  };
}

export function registerV2McpTools(server) {
  server.registerTool(
    "project_get",
    {
      title: "Get project",
      description: "Return a project with verified vs draft memory.",
      inputSchema: { project_id: z.coerce.number().int() },
    },
    wrap("project_get", async ({ project_id }) => jsonResult(getProjectFull(project_id))),
  );

  server.registerTool(
    "project_update",
    {
      title: "Update project",
      description: "Update project metadata, goal, or verification profile.",
      inputSchema: {
        project_id: z.coerce.number().int(),
        name: z.string().optional(),
        repo_url: z.string().optional(),
        description: z.string().optional(),
        goal: z.string().optional(),
        verify_json: z.string().optional(),
      },
    },
    wrap("project_update", async (args) => jsonResult(updateProject(args.project_id, args))),
  );

  server.registerTool(
    "project_orchestrate",
    {
      title: "Orchestrate project",
      description: "Analyze the repo, create a role-based plan, optionally launch ready tasks.",
      inputSchema: {
        project_id: z.coerce.number().int(),
        execute: z.boolean().optional(),
        model: z.string().optional(),
      },
    },
    wrap("project_orchestrate", async (args) => jsonResult(await orchestrateProject(args.project_id, args))),
  );

  server.registerTool(
    "agent_create",
    {
      title: "Create tracked agent",
      description: "Launch a Cursor agent and persist project/task/run links.",
      inputSchema: {
        prompt: z.string(),
        repository: z.string().optional(),
        ref: z.string().optional(),
        model: z.string().optional(),
        name: z.string().optional(),
        project_id: z.coerce.number().int().optional(),
        task_id: z.coerce.number().int().optional(),
        role: z.string().optional(),
        autoCreatePR: z.boolean().optional(),
      },
    },
    wrap("agent_create", async (args) => jsonResult(await launchTrackedAgent(args))),
  );

  server.registerTool(
    "agent_get",
    {
      title: "Get tracked agent",
      inputSchema: { agentId: z.string() },
    },
    wrap("agent_get", async ({ agentId }) => {
      const live = await getAgent(agentId).catch(() => null);
      return jsonResult({ record: getAgentRecord(agentId), live: live ? await enrichAgent(live) : null });
    }),
  );

  server.registerTool(
    "agent_list",
    {
      title: "List tracked agents",
      inputSchema: { project_id: z.coerce.number().int().optional() },
    },
    wrap("agent_list", async (args) => jsonResult({ items: listAgentRecords(args) })),
  );

  server.registerTool(
    "agent_followup",
    {
      title: "Follow up a tracked agent",
      inputSchema: { agentId: z.string(), prompt: z.string() },
    },
    wrap("agent_followup", async ({ agentId, prompt }) => jsonResult(await createRun(agentId, { prompt }))),
  );

  server.registerTool(
    "agent_stop",
    {
      title: "Cancel the active run",
      description: "POST /v1/agents/{id}/runs/{runId}/cancel. Fails if Cursor reports run_not_cancellable.",
      inputSchema: { agentId: z.string() },
    },
    wrap("agent_stop", async ({ agentId }) => jsonResult(await stopTrackedAgent(agentId))),
  );

  server.registerTool(
    "task_create",
    {
      title: "Create task",
      inputSchema: {
        project_id: z.coerce.number().int(),
        title: z.string(),
        description: z.string().optional(),
        role: z.string().optional(),
        depends_on: z.array(z.coerce.number().int()).optional(),
        agent_id: z.string().optional(),
      },
    },
    wrap("task_create", async (args) => jsonResult(addTask(args))),
  );

  server.registerTool(
    "task_get",
    {
      title: "Get task",
      inputSchema: { task_id: z.coerce.number().int() },
    },
    wrap("task_get", async ({ task_id }) => jsonResult(getTask(task_id))),
  );

  server.registerTool(
    "task_update",
    {
      title: "Update task status",
      inputSchema: {
        task_id: z.coerce.number().int(),
        new_status: z.enum(["pending", "blocked", "in_progress", "partial", "failed"]),
        notes: z.string().optional(),
      },
    },
    wrap("task_update", async (args) => jsonResult(updateTaskStatus(args))),
  );

  server.registerTool(
    "task_complete_proposal",
    {
      title: "Propose task complete",
      inputSchema: { task_id: z.coerce.number().int(), evidence: z.string() },
    },
    wrap("task_complete_proposal", async (args) => jsonResult(await proposeTaskDone(args))),
  );

  server.registerTool(
    "plan_create",
    {
      title: "Save plan prompt",
      inputSchema: { project_id: z.coerce.number().int(), prompt_text: z.string() },
    },
    wrap("plan_create", async (args) => jsonResult(savePlanPrompt(args))),
  );

  server.registerTool(
    "plan_get",
    {
      title: "Get latest plan",
      inputSchema: { project_id: z.coerce.number().int() },
    },
    wrap("plan_get", async ({ project_id }) => jsonResult(latestPlanPrompt(project_id) || null)),
  );

  server.registerTool(
    "plan_update",
    {
      title: "Save a new plan version",
      inputSchema: { project_id: z.coerce.number().int(), prompt_text: z.string() },
    },
    wrap("plan_update", async (args) => jsonResult(savePlanPrompt(args))),
  );

  server.registerTool(
    "run_tests",
    {
      title: "Run verification",
      inputSchema: { agentId: z.string().optional(), project_id: z.coerce.number().int().optional() },
    },
    wrap("run_tests", async (args) => {
      const rec = args.agentId ? getAgentRecord(args.agentId) : null;
      const project = args.project_id
        ? getDbProject(args.project_id)
        : rec?.project_id
          ? getDbProject(rec.project_id)
          : null;
      return jsonResult(
        await verifyAgentCompletion({
          agent: rec,
          run: rec ? { id: rec.latest_run_id, status: rec.state === "COMPLETED" ? "FINISHED" : rec.state } : { status: "FINISHED" },
          project,
        }),
      );
    }),
  );

  server.registerTool(
    "get_verification_status",
    {
      title: "Verification rows",
      inputSchema: { agentId: z.string() },
    },
    wrap("get_verification_status", async ({ agentId }) => jsonResult(latestVerification(agentId))),
  );

  server.registerTool(
    "get_build_status",
    {
      title: "Project verification history",
      inputSchema: { project_id: z.coerce.number().int() },
    },
    wrap("get_build_status", async ({ project_id }) => jsonResult(latestBuildStatus(project_id))),
  );

  server.registerTool(
    "get_pr",
    {
      title: "Fetch GitHub PR",
      inputSchema: { pr_url: z.string() },
    },
    wrap("get_pr", async ({ pr_url }) => jsonResult(await getPullRequest(pr_url))),
  );

  server.registerTool(
    "get_pr_status",
    {
      title: "Inspect GitHub PR existence and checks",
      inputSchema: { pr_url: z.string() },
    },
    wrap("get_pr_status", async ({ pr_url }) => jsonResult(await inspectPullRequest(pr_url))),
  );

  server.registerTool(
    "create_pr",
    {
      title: "Create GitHub PR",
      description: "Requires GITHUB_TOKEN. Does not record a PR until GitHub accepts it.",
      inputSchema: {
        repo_url: z.string(),
        title: z.string(),
        head: z.string(),
        base: z.string().optional(),
        body: z.string().optional(),
        project_id: z.coerce.number().int().optional(),
      },
    },
    wrap("create_pr", async (args) => {
      const created = await createPullRequest(args);
      if (args.project_id && created.html_url) {
        await addPrLink({ project_id: args.project_id, pr_url: created.html_url, comment: "created via MCP" });
      }
      return jsonResult(created);
    }),
  );

  server.registerTool(
    "telegram_send",
    {
      title: "Send Telegram message",
      inputSchema: { text: z.string() },
    },
    wrap("telegram_send", async ({ text }) => jsonResult(await telegramService.broadcast(text))),
  );

  server.registerTool(
    "telegram_test",
    {
      title: "Send Telegram test",
    },
    wrap("telegram_test", async () => jsonResult(await telegramService.broadcast("MCP telegram_test"))),
  );

  server.registerTool(
    "notification_preferences",
    {
      title: "Notification targets",
    },
    wrap("notification_preferences", async () =>
      jsonResult({ targets: telegramService.targets().map((id) => String(id).slice(0, 4) + "…") }),
    ),
  );

  server.registerTool(
    "event_list",
    {
      title: "List internal events",
      inputSchema: { limit: z.number().int().optional(), type: z.string().optional() },
    },
    wrap("event_list", async (args) => jsonResult(listEvents(args))),
  );

  server.registerTool(
    "event_get",
    {
      title: "Get event",
      inputSchema: { event_id: z.string() },
    },
    wrap("event_get", async ({ event_id }) => jsonResult(getEvent(event_id))),
  );

  server.registerTool(
    "event_retry",
    {
      title: "Retry event",
      inputSchema: { event_id: z.string() },
    },
    wrap("event_retry", async ({ event_id }) => jsonResult(await retryEvent(event_id))),
  );
}

function getDbProject(id) {
  return listProjects().find((p) => p.id === Number(id)) || null;
}
