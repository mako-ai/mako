/**
 * Re-export shim: the console modification engine moved to
 * `@mako/agent-tools` (packages/agent-tools/src/console-modification.ts) so
 * the API's server-side modify_console execution applies modifications with
 * EXACTLY the same semantics as the browser. Keep importing from here in app
 * code; do not fork the logic.
 */
export { applyModification, buildModificationDiff } from "@mako/agent-tools";
