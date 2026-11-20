import mongoose, { Schema, Document, Types } from "mongoose";
import {
  WORKSPACE_API_KEY_SCOPES,
  type WorkspaceApiKeyScope,
} from "../../auth/api-key-scopes";

/**
 * Workspace model interface
 */
export interface IWorkspaceBilling {
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  subscriptionStatus:
    "active" | "past_due" | "canceled" | "trialing" | "incomplete" | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  usageQuotaUsd: number;
  hardLimitUsd: number | null;
  plan: "free" | "pro" | "enterprise";
  lastReportedOverageCents?: number;
  pendingReportedOverageCents?: number | null;
  pendingMeterEventIdempotencyKey?: string | null;
}

export interface IWorkspace extends Document {
  _id: Types.ObjectId;
  name: string;
  slug: string;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  settings: {
    maxDatabases: number;
    maxMembers: number;
    billingTier: "free" | "pro" | "enterprise";
    disabledModelIds?: string[];
    /**
     * Domain auto-join (apps.md §28): a signed-in person whose email domain
     * is listed becomes a member on first contact with the workspace — no
     * invitation — with this access role. How someone clicks a published
     * app's link, signs in, and is simply in.
     */
    autoJoin?: IWorkspaceAutoJoin;
    /**
     * Whether in-app app links (`/view/<workspace>/<app>`) unfurl with the
     * app's title, description and thumbnail in chat apps (Open Graph,
     * share-og.service). Only workspace-wide apps ever do. Default on;
     * `false` makes every in-app link preview generic.
     */
    linkPreviews?: boolean;
    /**
     * Byte cap in GiB on interactive BigQuery queries (agents, MCP,
     * consoles, notebooks, binding previews). Unset: agent and MCP queries carry the platform default (500 GiB), others none.
     * 0: no cap. A connection's `agent_max_bytes_billed_gb` wins over it.
     */
    bigqueryMaxBytesBilledGb?: number;
  };
  billing: IWorkspaceBilling;
  apiKeys?: IWorkspaceApiKey[];
  /**
   * Connected GitHub repos — workspace-level infrastructure, not an apps
   * detail: apps (and later consoles, dbt projects) mount into these. Mako
   * stores nothing in Mongo except these links: the repos themselves are the
   * durable store. Layout inside a repo: `<makoRoot>/apps/<app>` for
   * workspace content, `<makoRoot>/users/<handle>/apps/<app>` for personal.
   * The model allows N repos; the product default is one.
   */
  workspaceRepos?: IWorkspaceRepoBinding[];
  /** @deprecated pre-workspaceRepos single binding — migrated at read time. */
  appsRepo?: IWorkspaceRepoBinding;
  /**
   * Workflows as code (docs/src/content/docs/workflows.md). Mako stores how to reach
   * the workspace's Hatchet tenant and which commit its worker runs.
   * Workflows and schedules live in git; runs and logs live in Hatchet.
   */
  workflows?: IWorkspaceWorkflows;
}

/**
 * One deployed version of `workflows/`: the commit the worker should run,
 * the commit it reports running, and the last commit it could not start.
 */
export interface IWorkflowSlot {
  sha: string;
  tree: string;
  /** The workflow folders at that commit: what the screen lists. */
  names: string[];
  running?: { sha: string };
  failed?: { sha: string; error: string };
}

export interface IWorkspaceWorkflows {
  /**
   * The workspace's Hatchet API token, encrypted like connection secrets.
   * Absent when the installation shares one token (HATCHET_CLIENT_TOKEN).
   */
  hatchetToken?: string;
  /** `workflows/` on main. */
  live?: IWorkflowSlot;
  /**
   * Workflows whose triggers are on. A workflow starts off: it runs only
   * when started by hand, until an admin activates it and its schedule and
   * webhook go live. A sandbox never has triggers.
   */
  active?: string[];
  /** Workflows with a webhook turned on: name → its URL's secret, encrypted. */
  webhooks?: Record<string, string>;
  /**
   * When the worker was last needed: a run, a deploy, a trigger change, or
   * Hatchet holding work for it. Its last pod stops once this is old
   * (workflows/scale.ts).
   */
  lastNeededAt?: Date;
}

export interface IWorkspaceRepoBinding {
  provider: "github";
  /** GitHub App installation granting repo access (omit for public repos). */
  installationId?: number;
  owner: string;
  repo: string;
  /** Default/main branch conversations fork from and publish merges into. */
  defaultBranch: string;
  /**
   * The Mako root — the folder Mako owns in this repo ("" = repo root).
   * Apps always live under `<subdirectory>/apps/<app>`.
   */
  subdirectory: string;
  linkedBy?: string;
  linkedAt?: Date;
}

/**
 * API Key interface for workspace authentication
 */
export interface IWorkspaceAutoJoin {
  /** Lowercase email domains, exact match (no sub-domains). */
  domains: string[];
  /** The ACCESS role newcomers get. Never owner/admin. */
  role: "member" | "viewer";
}

export interface IWorkspaceApiKey {
  _id?: Types.ObjectId;
  name: string;
  keyHash: string;
  prefix: string; // First 8 characters to help identify the key
  scopes?: WorkspaceApiKeyScope[];
  createdAt: Date;
  lastUsedAt?: Date;
  createdBy: string;
  /**
   * A sandbox run started with an API key (CI, a script): it acts as its
   * person but only reads through connections; its writes are refused
   * (connections/proxy.service.ts).
   */
  agentRun?: boolean;
  /**
   * A sandbox dry run: its connection writes are recorded under the run,
   * which the key's name gives, instead of sent, and its SQL only reads.
   */
  recordWrites?: boolean;
}

/**
 * Workspace Schema
 */
const WorkflowSlotFields = {
  sha: String,
  tree: String,
  names: { type: [String], default: undefined },
  running: { type: { sha: String }, _id: false },
  failed: { type: { sha: String, error: String }, _id: false },
};

const WorkspaceSchema = new Schema<IWorkspace>(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    createdBy: {
      type: String,
      ref: "User",
      required: true,
    },
    settings: {
      maxDatabases: {
        type: Number,
        default: 5,
      },
      maxMembers: {
        type: Number,
        default: 10,
      },
      billingTier: {
        type: String,
        enum: ["free", "pro", "enterprise"],
        default: "free",
      },
      disabledModelIds: [{ type: String }],
      autoJoin: {
        type: new Schema(
          {
            domains: [{ type: String, lowercase: true, trim: true }],
            role: {
              type: String,
              enum: ["member", "viewer"],
              default: "viewer",
            },
          },
          { _id: false },
        ),
        required: false,
      },
      linkPreviews: { type: Boolean, required: false },
      bigqueryMaxBytesBilledGb: { type: Number, required: false, min: 0 },
    },
    billing: {
      stripeCustomerId: { type: String, default: null },
      stripeSubscriptionId: { type: String, default: null },
      subscriptionStatus: {
        type: String,
        enum: [
          "active",
          "past_due",
          "canceled",
          "trialing",
          "incomplete",
          null,
        ],
        default: null,
      },
      currentPeriodStart: { type: Date, default: null },
      currentPeriodEnd: { type: Date, default: null },
      usageQuotaUsd: { type: Number, default: 5 },
      hardLimitUsd: { type: Number, default: 5 },
      plan: {
        type: String,
        enum: ["free", "pro", "enterprise"],
        default: "free",
      },
      lastReportedOverageCents: { type: Number, default: 0 },
      pendingReportedOverageCents: { type: Number, default: null },
      pendingMeterEventIdempotencyKey: { type: String, default: null },
    },
    workspaceRepos: {
      type: [
        new Schema(
          {
            provider: { type: String, enum: ["github"], default: "github" },
            installationId: { type: Number },
            owner: { type: String, required: true, trim: true },
            repo: { type: String, required: true, trim: true },
            defaultBranch: { type: String, required: true, default: "main" },
            // Mako root ("" = repo root); apps live at <root>/apps/<app>.
            subdirectory: { type: String, default: "" },
            linkedBy: { type: String },
            linkedAt: { type: Date },
          },
          { _id: false },
        ),
      ],
      default: undefined,
    },
    workflows: {
      type: {
        hatchetToken: { type: String },
        live: { type: WorkflowSlotFields, _id: false },
        active: { type: [String], default: undefined },
        webhooks: { type: Schema.Types.Mixed },
        lastNeededAt: { type: Date },
      },
      default: undefined,
      _id: false,
    },
    appsRepo: {
      type: {
        provider: { type: String, enum: ["github"], default: "github" },
        installationId: { type: Number },
        owner: { type: String, required: true, trim: true },
        repo: { type: String, required: true, trim: true },
        defaultBranch: { type: String, required: true, default: "main" },
        subdirectory: { type: String, default: "" },
        linkedBy: { type: String },
        linkedAt: { type: Date },
      },
      default: undefined,
      _id: false,
    },
    apiKeys: [
      {
        name: {
          type: String,
          required: true,
          trim: true,
        },
        keyHash: {
          type: String,
          required: true,
        },
        prefix: {
          type: String,
          required: true,
        },
        scopes: {
          type: [
            {
              type: String,
              enum: WORKSPACE_API_KEY_SCOPES,
            },
          ],
          default: undefined,
        },
        createdAt: {
          type: Date,
          default: Date.now,
        },
        lastUsedAt: {
          type: Date,
        },
        createdBy: {
          type: String,
          ref: "User",
          required: true,
        },
        agentRun: { type: Boolean },
        recordWrites: { type: Boolean },
      },
    ],
  },
  {
    timestamps: true,
  },
);

// Indexes
WorkspaceSchema.index({ createdBy: 1 });

export const Workspace = mongoose.model<IWorkspace>(
  "Workspace",
  WorkspaceSchema,
);
