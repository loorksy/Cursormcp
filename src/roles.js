import { AGENT_ROLES } from "./config.js";

const STACK_ROLES = [
  { test: /typescript|javascript|node|python|go|java|php|ruby/i, roles: ["Backend"] },
  { test: /html|css|react|vue|svelte/i, roles: ["Frontend", "UI/UX"] },
  { test: /sql|postgres|mysql|sqlite|mongo/i, roles: ["Database"] },
  { test: /docker|kubernetes|terraform|nginx/i, roles: ["DevOps"] },
];

export function selectRoles({ languages = {}, goal = "" } = {}) {
  const langBlob = Object.keys(languages).join(" ") + " " + goal;
  const picked = new Set(["Planner", "Code Reviewer", "QA"]);
  for (const rule of STACK_ROLES) {
    if (rule.test.test(langBlob)) for (const r of rule.roles) picked.add(r);
  }
  if (/security|auth|oauth/i.test(goal)) picked.add("Security");
  if (/docs|readme|documentation/i.test(goal)) picked.add("Documentation");
  if (/test/i.test(goal)) picked.add("Testing");
  if (/architect|design|refactor/i.test(goal)) picked.add("Architect");
  return AGENT_ROLES.filter((r) => picked.has(r));
}

export function rolePrompt(role, { goal, taskTitle, repository }) {
  return [
    `You are the ${role} agent for this repository: ${repository || "(unspecified)"}.`,
    `Project goal: ${goal || "(none)"}`,
    `Your assigned task: ${taskTitle}`,
    "Follow repository conventions. Do not invent secrets. Open or update a PR with evidence.",
    "When finished, include the PR URL in your summary.",
  ].join("\n");
}
