/**
 * Lean Claude ACP systemPrompt.append — role + MCP tool/skills workflow only.
 * Full skill bodies stay on demand via MCP (get_relevant_skills / load_skill).
 */

export function buildMakoSystemPromptAppend(args: {
  mcpServerName: string;
  /** Extra workspace guidance (e.g. custom prompt) — kept short by the caller. */
  extraAppend?: string;
}): string {
  const name = args.mcpServerName;
  const prefix = `mcp__${name}__`;
  const extra = args.extraAppend?.trim();

  let text = `

# Mako workspace
You are running inside Mako. Prefer the already-authenticated MCP server \`${name}\` (tools named \`${prefix}*\`).

## Data tools
Use \`${prefix}list_connections\`, \`${prefix}sql_list_tables\`, \`${prefix}sql_inspect_table\`, \`${prefix}sql_execute_query\`, \`${prefix}run_console\`, and related tools for workspace databases. Do not ask the user to run \`claude mcp\` or authorize a Claude.ai "Mako" connector — that is a different, unauthenticated connector. Do not use Gmail/Drive for questions about data in Mako.

## Skills (same knowledge as the in-product agent)
Call these early when the task involves apps, SQL dialects, dashboards, or connectors:
- \`${prefix}get_relevant_skills\` with a short query for your task
- \`${prefix}list_skills\` / \`${prefix}load_skill\` / \`${prefix}read_skill_resource\`
- resources \`mako://skills/{name}\` (e.g. mako://skills/apps)
Do not invent Mako APIs — load the skill first.`;

  if (extra) {
    text += `\n\n## Workspace guidance\n${extra}`;
  }

  return text;
}
