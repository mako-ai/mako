/**
 * Mode-switching types for the unified agent.
 *
 * Two orthogonal axes:
 * - Expertise mode (dynamic): which domain toolset + guidance is loaded. The
 *   model switches expertise modes mid-conversation via the `enable_mode` tool.
 * - Lifecycle mode (per chat): `agent` (default) vs `plan`. Plan mode adds the
 *   clarify -> plan -> approve -> execute state machine and the mutation gate.
 */

/** Dynamic expertise modes the model can enable via `enable_mode`. */
export type ExpertiseModeId = "sql" | "dashboard" | "flow" | "explore";

/** Per-chat lifecycle mode selected by the user. */
export type LifecycleMode = "agent" | "plan";

/**
 * A registered expertise mode. Modes reference tools *by name* — the actual
 * tool objects come from the existing builders (`createUniversalTools`,
 * `createFlowTools`, `clientDashboardTools`, ...). `prepareStep` intersects
 * the registered `toolNames` with the full tool set to derive `activeTools`.
 */
export interface AgentMode {
  /** Stable identifier used by `enable_mode`. */
  id: ExpertiseModeId;
  /** Human-friendly name for prompts / UI. */
  name: string;
  /** One-line description used in the `enable_mode` routing instructions. */
  routingPrompt: string;
  /** Domain guidance injected into the dynamic system block when enabled. */
  systemPrompt: string;
  /** Optional canned trajectories surfaced to `todo_write`. */
  trajectories?: string[];
  /** Names of the tools this mode unlocks. */
  toolNames: string[];
  /** When true, this mode only contains read-only tools. */
  readOnly?: boolean;
}

/**
 * Mutable per-request mode state. Seeded from `deriveModeState` (stateless scan
 * of the message history) and then mutated within the request by
 * `enable_mode.execute`. `prepareStep` reads it live on every step.
 */
export interface ModeState {
  /** Currently-enabled expertise modes. */
  enabledModes: Set<ExpertiseModeId>;
  /** Whether the user has approved a submitted plan (plan lifecycle only). */
  planApproved: boolean;
  /** The selected lifecycle mode for this chat. */
  lifecycle: LifecycleMode;
}
