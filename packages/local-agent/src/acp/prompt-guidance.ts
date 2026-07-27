/**
 * Codex (and any provider without systemPrompt.append) needs Mako guidance
 * injected into prompts. Full body on turn 1; short reminder thereafter.
 */

export function applyNonClaudeGuidanceToPrompt(args: {
  userText: string;
  guidanceAppend: string;
  alreadyInjected: boolean;
}): { text: string; injectedFull: boolean; injectedReminder: boolean } {
  const userText = args.userText.trim();
  const guidance = args.guidanceAppend.trim();
  if (!guidance) {
    return { text: userText, injectedFull: false, injectedReminder: false };
  }

  if (!args.alreadyInjected) {
    return {
      text: [
        "[Mako workspace system guidance — follow for this session]",
        guidance,
        "[End Mako workspace system guidance]",
        "",
        userText,
      ].join("\n"),
      injectedFull: true,
      injectedReminder: false,
    };
  }

  return {
    text: [
      "[Mako reminder] Prefer mako-workspace MCP tools for data; call " +
        "read_self_directive for workspace memory; use mako-desktop " +
        "ask_clarifying_questions/submit_plan for decisions; never use " +
        "claude mcp or local MEMORY.md.",
      "",
      userText,
    ].join("\n"),
    injectedFull: false,
    injectedReminder: true,
  };
}
