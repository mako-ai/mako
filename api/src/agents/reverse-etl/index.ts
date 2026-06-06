import { tool } from "ai";
import { z } from "zod";
import { Types } from "mongoose";
import { clientReverseEtlTools } from "@mako/agent-tools";
import { Connector, DatabaseConnection } from "../../database/workspace-schema";
import type { AgentContext } from "../types";
import {
  checkQuerySafety,
  validateQuery as validateQueryService,
} from "../../services/destination-writer.service";
import { getOutboundConnector } from "../../services/reverse-etl/outbound";
import { dryRunReverseEtl } from "../../services/reverse-etl/dry-run.service";
import { REVERSE_FLOW_SPEC_SCHEMA } from "../../schemas/reverse-flow.schema";

const inspectDestinationSchema = z.object({
  connectorId: z.string().describe("Destination connector ID"),
  entity: z.string().default("leads").describe("Destination entity"),
});

const validateReverseQuerySchema = z.object({
  connectionId: z.string().describe("Source database connection ID"),
  query: z.string().describe("SQL query to validate"),
  database: z.string().optional().describe("Optional database or dataset"),
});

const dryRunMappingSchema = z.object({
  spec: REVERSE_FLOW_SPEC_SCHEMA.describe(
    "Complete ReverseFlowSpec to dry run",
  ),
  sampleSize: z.number().int().positive().max(100).default(25),
});

export function createReverseEtlTools(
  workspaceId: string,
  _toolExecutionContext?: AgentContext["toolExecutionContext"],
) {
  return {
    list_connectors: tool({
      description:
        "List workspace connectors that may be usable as Reverse ETL destinations. Use inspect_destination to verify outbound support.",
      inputSchema: z.object({}),
      execute: async () => {
        const connectors = await Connector.find({
          workspaceId: new Types.ObjectId(workspaceId),
          isActive: { $ne: false },
        })
          .select("_id name type")
          .lean();
        return {
          success: true,
          connectors: connectors.map(connector => ({
            id: connector._id.toString(),
            name: connector.name,
            type: connector.type,
          })),
        };
      },
    }),

    inspect_destination: tool({
      description:
        "Inspect writable destination fields, enum values, and matchable fields for a Reverse ETL connector entity.",
      inputSchema: inspectDestinationSchema,
      execute: async ({ connectorId, entity }) => {
        try {
          const outbound = await getOutboundConnector(connectorId);
          const schema = await outbound.resolveOutboundSchema(entity);
          return { success: true, schema };
        } catch (error) {
          return {
            success: false,
            error:
              error instanceof Error
                ? error.message
                : "Failed to inspect destination",
          };
        }
      },
    }),

    reverse_etl_validate_query: tool({
      description:
        "Validate a Reverse ETL source SQL query and return columns/sample info. Use before mappings.",
      inputSchema: validateReverseQuerySchema,
      execute: async ({ connectionId, query, database }) => {
        try {
          if (!Types.ObjectId.isValid(connectionId)) {
            return { success: false, error: "Invalid connection ID" };
          }
          const safety = checkQuerySafety(query);
          if (!safety.safe) {
            return {
              success: false,
              errors: safety.errors,
              warnings: safety.warnings,
            };
          }
          const connection = await DatabaseConnection.findOne({
            _id: new Types.ObjectId(connectionId),
            workspaceId: new Types.ObjectId(workspaceId),
          });
          if (!connection)
            return { success: false, error: "Connection not found" };
          return await validateQueryService(
            connection.toObject({ getters: true }) as any,
            query,
            database,
          );
        } catch (error) {
          return {
            success: false,
            error:
              error instanceof Error
                ? error.message
                : "Query validation failed",
          };
        }
      },
    }),

    dry_run_mapping: tool({
      description:
        "Dry run a Reverse ETL mapping through the outbound connector. Writes nothing and returns payloads, matches, and field diffs.",
      inputSchema: dryRunMappingSchema,
      execute: async ({ spec, sampleSize }) => {
        try {
          const result = await dryRunReverseEtl(workspaceId, spec, sampleSize);
          return { success: true, ...result };
        } catch (error) {
          return {
            success: false,
            error:
              error instanceof Error
                ? error.message
                : "Reverse ETL dry run failed",
          };
        }
      },
    }),

    ...clientReverseEtlTools,
  };
}
