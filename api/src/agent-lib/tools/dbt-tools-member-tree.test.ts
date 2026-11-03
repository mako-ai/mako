/**
 * Members validate the committed tracked branch only (Joan, 2026-10-30):
 * dbt_parse / dbt_compile_model / dbt_show queue runs WITHOUT a working-tree
 * user for a member, so drafts and other refs never build. Owners and admins
 * keep their working tree. Covers the tool set as the MCP server builds it
 * and as the in-product agent runs it (behind the capability wrapper).
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { CAPABILITY_GRANTS } from "@mako/agent-tools";
import type { ToolSet } from "ai";

const state = vi.hoisted(() => ({
  role: "member" as string | null,
  calls: [] as Array<Record<string, unknown>>,
}));

vi.mock("../../services/realtime.service", () => ({
  publishRealtimeEvent: vi.fn(),
}));
vi.mock("../../services/workspace.service", () => ({
  workspaceService: {
    hasAccess: vi.fn(async () => true),
    getMember: vi.fn(async () => (state.role ? { role: state.role } : null)),
  },
}));
vi.mock("../../dbt/dbt-project.service", () => ({
  loadDbtDeferState: vi.fn(async () => undefined),
  runAdhocDbtCommand: vi.fn(),
}));
vi.mock("../../dbt/dbt-run.service", () => ({
  triggerDbtRun: vi.fn(async (params: Record<string, unknown>) => {
    state.calls.push(params);
    return {
      _id: new Types.ObjectId(),
      status: "queued",
      environment: params.environment,
      commands: params.commands,
    };
  }),
  triggerDbtJobRun: vi.fn(),
  requestDbtRunCancel: vi.fn(),
  reconcileStaleQueuedRun: vi.fn(async (run: unknown) => run),
  applyJobScheduleChange: vi.fn(),
}));
vi.mock("../../services/scheduled-query-schedule.service", () => ({
  validateScheduledConsoleSchedule: vi.fn(() => null),
}));

import { createDbtServerTools } from "./dbt-tools";
import { enforceCapabilityGrantsAtExecution } from "../capabilities/runtime";
import { DbtProject } from "../../database/workspace-schema";

let mongo: MongoMemoryServer;
const WS = new Types.ObjectId().toString();
const USER = "u-member";

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  await DbtProject.deleteMany({});
  state.calls = [];
});

async function seed() {
  return DbtProject.create({
    workspaceId: new Types.ObjectId(WS),
    name: "Analytics",
    environments: [
      {
        name: "dev",
        connectionId: new Types.ObjectId(),
        targetSchema: "dbt_dev",
        threads: 4,
      },
    ],
    defaultEnvironment: "dev",
    createdBy: "tester",
  });
}

type Exec = (input: unknown, options: unknown) => Promise<unknown>;
const call = (tools: ToolSet, name: string, input: unknown) =>
  (tools[name].execute as Exec)(input, {}) as Promise<Record<string, unknown>>;

const VALIDATION = [
  ["dbt_parse", {}],
  ["dbt_compile_model", { model: "stg_orders" }],
  ["dbt_show", { model: "stg_orders", limit: 5 }],
] as const;

describe.each([
  ["MCP tool set", () => createDbtServerTools(WS, USER, { chatId: "mcp" })],
  [
    "in-product agent",
    () =>
      enforceCapabilityGrantsAtExecution(
        createDbtServerTools(WS, USER, { chatId: "chat" }) as ToolSet,
        () => new Set(CAPABILITY_GRANTS),
        async () => state.role,
      ),
  ],
] as const)("%s", (_surface, build) => {
  it.each(VALIDATION)(
    "a member's %s builds the committed tracked branch",
    async (name, input) => {
      state.role = "member";
      const project = await seed();
      const result = await call(build() as ToolSet, name, {
        projectId: project._id.toString(),
        ...input,
      });
      expect(result.success).toBe(true);
      expect(state.calls).toHaveLength(1);
      expect(state.calls[0].workingTreeUserId).toBeUndefined();
      expect(String(result.source)).toContain("committed tracked branch");
    },
  );

  it.each(VALIDATION)(
    "an admin's %s still builds their working tree",
    async (name, input) => {
      state.role = "admin";
      const project = await seed();
      const result = await call(build() as ToolSet, name, {
        projectId: project._id.toString(),
        ...input,
      });
      expect(result.success).toBe(true);
      expect(state.calls[0].workingTreeUserId).toBe(USER);
      expect(result.source).toBeUndefined();
    },
  );
});
