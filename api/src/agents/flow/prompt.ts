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

import { generateFieldDocs, FIELD_PATHS } from "@mako/schemas";
import {
  getSystemSkillFullText,
  registerSystemSkillTemplate,
} from "../../agent-lib/skills/system-skills";

/**
 * The flow guide lives in the `flows` system skill package
 * (`api/src/agent-skills/flows/SKILL.md`) so there is a single source of truth.
 * The form-field reference is auto-generated from the unified schema, so the
 * SKILL.md body carries `{{FLOW_FORM_FIELDS}}` / `{{FLOW_FIELD_PATHS}}`
 * placeholders that we substitute at read time. Registering the template here
 * (at module load) ensures both the standalone flow agent (`FLOW_PROMPT`) and
 * the unified agent's on-demand `load_skill` get the substituted body. The flow
 * agent index imports this module at boot, so the registration always runs.
 */
registerSystemSkillTemplate("flows", () => ({
  FLOW_FORM_FIELDS: generateFieldDocs(),
  FLOW_FIELD_PATHS: FIELD_PATHS.join("\n"),
}));

// Built once at startup for performance.
export const FLOW_PROMPT = getSystemSkillFullText("flows");
