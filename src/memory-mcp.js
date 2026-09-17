import { z } from "zod";
import {
  MemoryError,
  addPrLink,
  addTask,
  createProject,
  currentActor,
  getProjectCapsule,
  getProjectFull,
  latestPlanPrompt,
  listApprovedRules,
  listPrLinks,
  listProjects,
  logError,
  proposeTaskDone,
  resolveError,
  savePlanPrompt,
  saveUiUx,
  saveUxNote,
  suggestRule,
  systemGuideText,
  updateTaskStatus,
} from "./memory.js";
import { logRequest } from "./lib.js";

function jsonResult(data) {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

function textResult(text) {
  return {
    content: [{ type: "text", text }],
  };
}

function errorResult(err) {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify(
          { error: err.message, status: err.status || null, body: err.body || null },
          null,
          2,
        ),
      },
    ],
  };
}

function wrap(tool, fn) {
  return async (args = {}) => {
    try {
      const data = await fn(args);
      logRequest({ source: "mcp", tool, status: 200, detail: currentActor() });
      return data;
    } catch (err) {
      logRequest({ source: "mcp", tool, status: err.status || 500, detail: err.message });
      if (!(err instanceof MemoryError)) return errorResult(err);
      return errorResult(err);
    }
  };
}

export function registerMemoryMcpTools(server) {
  server.registerTool(
    "get_system_guide",
    {
      title: "System guide",
      description:
        "Public operational guide for the governed memory system. Use this first. Contains no project data.",
    },
    wrap("get_system_guide", async () => textResult(systemGuideText())),
  );

  server.registerTool(
    "project_list",
    {
      title: "List memory projects",
      description: "List projects stored in the central memory database.",
    },
    wrap("project_list", async () => jsonResult(listProjects())),
  );

  server.registerTool(
    "project_create",
    {
      title: "Create memory project",
      description: "Create a new governed memory project.",
      inputSchema: {
        name: z.string(),
        repo_url: z.string().optional(),
        description: z.string().optional(),
      },
    },
    wrap("project_create", async (args) => jsonResult(createProject(args))),
  );

  server.registerTool(
    "project_get_full",
    {
      title: "Full project memory",
      description: "Return verified vs draft project memory. Do not treat Draft as final truth.",
      inputSchema: {
        project_id: z.coerce.number().int().optional(),
        project_name: z.string().optional(),
      },
    },
    wrap("project_get_full", async (args) => jsonResult(getProjectFull(args.project_id, args.project_name))),
  );

  server.registerTool(
    "project_get_capsule",
    {
      title: "Project context capsule",
      description: "Compact verified-only summary. Recommended first read after get_system_guide.",
      inputSchema: {
        project_id: z.coerce.number().int().optional(),
        project_name: z.string().optional(),
      },
    },
    wrap("project_get_capsule", async (args) => {
      const capsule = getProjectCapsule(args.project_id, args.project_name);
      return textResult(capsule.text);
    }),
  );

  server.registerTool(
    "task_add",
    {
      title: "Add memory task",
      description: "Add a draft task. Status starts as pending and is not verified.",
      inputSchema: {
        project_id: z.coerce.number().int(),
        title: z.string(),
        description: z.string().optional(),
        proposed_by: z.string().optional(),
        agent_id: z.string().optional(),
      },
    },
    wrap("task_add", async (args) => jsonResult(addTask(args))),
  );

  server.registerTool(
    "task_propose_done",
    {
      title: "Propose task done",
      description: "Set status to done_proposed. Evidence is required. Never becomes done_verified via MCP.",
      inputSchema: {
        task_id: z.coerce.number().int(),
        evidence: z.string(),
      },
    },
    wrap("task_propose_done", async (args) => jsonResult(await proposeTaskDone(args))),
  );

  server.registerTool(
    "task_update_status",
    {
      title: "Update task status",
      description: "Update status except done_proposed and done_verified.",
      inputSchema: {
        task_id: z.coerce.number().int(),
        new_status: z.enum(["pending", "in_progress", "partial", "failed"]),
        notes: z.string().optional(),
      },
    },
    wrap("task_update_status", async (args) => jsonResult(updateTaskStatus(args))),
  );

  server.registerTool(
    "error_log",
    {
      title: "Log project error",
      description: "Record an unresolved error in project memory.",
      inputSchema: {
        project_id: z.coerce.number().int(),
        title: z.string(),
        description: z.string().optional(),
        root_cause: z.string().optional(),
        task_id: z.coerce.number().int().optional(),
      },
    },
    wrap("error_log", async (args) => jsonResult(logError(args))),
  );

  server.registerTool(
    "error_resolve",
    {
      title: "Resolve project error",
      description: "Mark an error resolved with notes. Logged in audit_log.",
      inputSchema: {
        error_id: z.coerce.number().int(),
        resolution_notes: z.string(),
      },
    },
    wrap("error_resolve", async (args) => jsonResult(resolveError(args))),
  );

  server.registerTool(
    "plan_prompt_save",
    {
      title: "Save plan prompt",
      description: "Save a draft plan prompt. Capsule uses it only after dashboard verification.",
      inputSchema: {
        project_id: z.coerce.number().int(),
        prompt_text: z.string(),
      },
    },
    wrap("plan_prompt_save", async (args) => jsonResult(savePlanPrompt(args))),
  );

  server.registerTool(
    "plan_prompt_get_latest",
    {
      title: "Latest plan prompt",
      description: "Return the latest plan prompt (draft or verified).",
      inputSchema: {
        project_id: z.coerce.number().int(),
      },
    },
    wrap("plan_prompt_get_latest", async (args) => jsonResult(latestPlanPrompt(args.project_id) || null)),
  );

  server.registerTool(
    "ui_ux_save",
    {
      title: "Save UI/UX note",
      description: "Save a draft UI/UX note. Remains Draft until verified in the dashboard.",
      inputSchema: {
        project_id: z.coerce.number().int(),
        category: z.string().optional(),
        notes: z.string(),
      },
    },
    wrap("ui_ux_save", async (args) => jsonResult(saveUiUx(args))),
  );

  server.registerTool(
    "ux_notes_save",
    {
      title: "Save UX flow note",
      description: "Save a draft user-experience note. Remains Draft until verified in the dashboard.",
      inputSchema: {
        project_id: z.coerce.number().int(),
        flow_name: z.string(),
        description: z.string().optional(),
      },
    },
    wrap("ux_notes_save", async (args) => jsonResult(saveUxNote(args))),
  );

  server.registerTool(
    "rules_suggest",
    {
      title: "Suggest a rule",
      description: "Suggest a rule. Does not write the approved rules table.",
      inputSchema: {
        project_id: z.coerce.number().int(),
        suggested_rule_text: z.string(),
        reason: z.string().optional(),
        proposed_by: z.string().optional(),
      },
    },
    wrap("rules_suggest", async (args) => jsonResult(suggestRule(args))),
  );

  server.registerTool(
    "rules_list",
    {
      title: "List approved rules",
      description: "Return approved rules only.",
      inputSchema: {
        project_id: z.coerce.number().int(),
      },
    },
    wrap("rules_list", async (args) => jsonResult(listApprovedRules(args.project_id))),
  );

  server.registerTool(
    "pr_link_add",
    {
      title: "Add PR link",
      description: "Store a pull request URL and run a lightweight public GitHub existence check.",
      inputSchema: {
        project_id: z.coerce.number().int(),
        pr_url: z.string(),
        comment: z.string().optional(),
        branch_name: z.string().optional(),
        task_id: z.coerce.number().int().optional(),
      },
    },
    wrap("pr_link_add", async (args) => jsonResult(await addPrLink(args))),
  );

  server.registerTool(
    "pr_link_list",
    {
      title: "List PR links",
      description: "List stored pull request links for a project.",
      inputSchema: {
        project_id: z.coerce.number().int(),
      },
    },
    wrap("pr_link_list", async (args) => jsonResult(listPrLinks(args.project_id))),
  );
}
