/**
 * Flow Agent System Prompt
 *
 * Specialized assistant for configuring database-to-database sync flows.
 * Guides users through query creation with template placeholders.
 *
 * IMPORTANT: Field documentation is auto-generated from the unified schema
 * in db-flow-form.schema.ts. This ensures the prompt always matches the actual
 * field definitions and prevents documentation drift.
 */

import { getSystemSkill } from "../../agent-lib/skills/system-skills";

function requireSystemSkillBody(name: string): string {
  const skill = getSystemSkill(name);
  if (!skill) {
    throw new Error(`Required system skill "${name}" was not discovered`);
  }
  return skill.body;
}

export const FLOW_PROMPT = requireSystemSkillBody("flows");
