import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

import { users } from "./auth";
import { databaseConnections } from "./connections";
import { workspaces } from "./workspaces";

/**
 * Consoles domain (was Mongo `consolefolders` and `savedconsoles`).
 *
 * Embedded subdocs (`lastRun`, `schedule`, `scheduledRun`, `sharedWith`,
 * `chartSpec`, `mongoOptions`) become JSONB. `descriptionEmbedding` becomes a
 * pgvector column (text-embedding-3-small = 1536 dims).
 */

export const consoleFolders = pgTable(
  "console_folders",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    parentId: uuid("parent_id"),
    access: text("access").$type<"private" | "workspace">(),
    ownerId: uuid("owner_id").references(() => users.id),
    isPrivate: boolean("is_private"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  table => [
    index("console_folders_workspace_idx").on(table.workspaceId),
    index("console_folders_parent_idx").on(table.parentId),
  ],
);

export interface ConsoleSharedWith {
  userId: string;
  role?: string;
}

export const savedConsoles = pgTable(
  "saved_consoles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    folderId: uuid("folder_id").references(() => consoleFolders.id, {
      onDelete: "set null",
    }),
    connectionId: uuid("connection_id").references(
      () => databaseConnections.id,
      { onDelete: "set null" },
    ),
    databaseName: text("database_name"),
    databaseId: text("database_id"),
    name: text("name").notNull(),
    description: text("description"),
    descriptionEmbedding: vector("description_embedding", {
      dimensions: 1536,
    }),
    language: text("language").$type<"sql" | "javascript" | "mongodb">(),
    code: text("code"),
    chartSpec: jsonb("chart_spec"),
    mongoOptions: jsonb("mongo_options"),
    lastRun: jsonb("last_run"),
    access: text("access"),
    workspaceRole: text("workspace_role"),
    sharedWith: jsonb("shared_with").$type<ConsoleSharedWith[]>(),
    schedule: jsonb("schedule"),
    scheduledRun: jsonb("scheduled_run"),
    version: integer("version").notNull().default(1),
    draftRevision: integer("draft_revision"),
    isSaved: boolean("is_saved").notNull().default(true),
    isDeleted: boolean("is_deleted").notNull().default(false),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    executionCount: integer("execution_count").notNull().default(0),
    lastExecutedAt: timestamp("last_executed_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id),
    ownerId: uuid("owner_id").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  table => [
    index("saved_consoles_workspace_idx").on(table.workspaceId),
    index("saved_consoles_folder_idx").on(table.folderId),
    index("saved_consoles_connection_idx").on(table.connectionId),
  ],
);

export type ConsoleFolderRow = typeof consoleFolders.$inferSelect;
export type NewConsoleFolderRow = typeof consoleFolders.$inferInsert;
export type SavedConsoleRow = typeof savedConsoles.$inferSelect;
export type NewSavedConsoleRow = typeof savedConsoles.$inferInsert;
