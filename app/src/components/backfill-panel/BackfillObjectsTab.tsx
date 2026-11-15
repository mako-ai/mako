import React from "react";
import {
  Box,
  Typography,
  LinearProgress,
  Chip,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  IconButton,
  Tooltip,
} from "@mui/material";
import {
  History as BackfillIcon,
  DeleteSweep as ResetTableIcon,
  ExpandMore as ExpandMoreIcon,
  ExpandLess as ExpandLessIcon,
  WarningAmber as WarningAmberIcon,
} from "@mui/icons-material";
import { pillToneForMuiColor, StatusPill } from "../bui-status";
import {
  entityLabel,
  entityStreamChip,
  entityBackfillChip,
} from "./backfill-helpers";
import { BorderedTableContainer, DenseHeadRow } from "./backfill-styles";
import type { BackfillPanelModel } from "./useBackfillPanel";

export function BackfillObjectsTab({ model }: { model: BackfillPanelModel }) {
  const {
    expandedEntity,
    entitySchemaCache,
    toggleEntitySchema,
    entityDrift,
    busy,
    isReconcileOnly,
    streamState,
    bfStatus,
    handleStartBackfill,
    openEntityResetDialog,
    entities,
  } = model;
  return (
    <Box sx={{ p: 2 }}>
      {entities.length === 0 ? (
        <Typography
          variant="body2"
          sx={{
            color: "text.secondary",
            textAlign: "center",
            py: 2,
          }}
        >
          No entities configured yet.
        </Typography>
      ) : (
        <BorderedTableContainer>
          <Table size="small">
            <TableHead>
              <DenseHeadRow>
                <TableCell>Entity</TableCell>
                <TableCell>Stream</TableCell>
                <TableCell>Backfill</TableCell>
                <TableCell align="right">Destination rows</TableCell>
                <TableCell align="right">Events processed</TableCell>
                <TableCell align="right" sx={{ width: 60 }} />
              </DenseHeadRow>
            </TableHead>
            <TableBody>
              {entities.map(e => {
                const sc = entityStreamChip(e, streamState);
                // A repartition (layout change) in progress/failed takes
                // precedence over the normal stream chip.
                const repart = e.repartition as {
                  status?: "pending" | "running" | "done" | "failed";
                  error?: string | null;
                } | null;
                const streamChip: {
                  label: string;
                  color: "success" | "info" | "default" | "error";
                } | null =
                  repart?.status === "pending" || repart?.status === "running"
                    ? { label: "Repartitioning…", color: "info" }
                    : repart?.status === "failed"
                      ? { label: "Repartition failed", color: "error" }
                      : isReconcileOnly
                        ? null
                        : sc;
                const bc = entityBackfillChip(e);
                const backfillChip =
                  e.execStatus === "syncing"
                    ? { label: "Syncing…", color: "info" as const }
                    : e.execStatus === "completed"
                      ? { label: "Done", color: "success" as const }
                      : e.execStatus === "pending"
                        ? { label: "Queued", color: "default" as const }
                        : bc;
                const destinationRows =
                  typeof e.destinationRowCount === "number"
                    ? Math.max(e.destinationRowCount, 0)
                    : null;
                const syncingRowsWritten = Math.max(e.execRows || 0, 0);
                const eventCount = e.lifetimeEventsProcessed || 0;
                const isExpanded = expandedEntity === e.entity;
                const schemaData = entitySchemaCache[e.entity];
                return (
                  <React.Fragment key={e.entity}>
                    <TableRow
                      sx={{
                        "&:last-child td": { borderBottom: 0 },
                        cursor: "pointer",
                        "&:hover": { bgcolor: "action.hover" },
                      }}
                      onClick={() => toggleEntitySchema(e.entity)}
                    >
                      <TableCell
                        sx={{
                          fontFamily: "monospace",
                          fontSize: "0.78rem",
                          fontWeight: 500,
                        }}
                      >
                        <Box
                          sx={{
                            display: "flex",
                            alignItems: "center",
                            gap: 0.5,
                          }}
                        >
                          {isExpanded ? (
                            <ExpandLessIcon
                              sx={{
                                fontSize: 16,
                                color: "text.secondary",
                              }}
                            />
                          ) : (
                            <ExpandMoreIcon
                              sx={{
                                fontSize: 16,
                                color: "text.secondary",
                              }}
                            />
                          )}
                          {entityLabel(e.entity)}
                          {entityDrift[e.entity]?.length > 0 && (
                            <Tooltip
                              title={
                                entityDrift[e.entity]
                                  .map(
                                    d =>
                                      `${d.column}: ${d.liveType} → ${d.expectedType}`,
                                  )
                                  .join("\n") +
                                "\nWill be auto-corrected on next sync."
                              }
                            >
                              <WarningAmberIcon
                                sx={{
                                  fontSize: 15,
                                  color: "warning.main",
                                  ml: 0.5,
                                }}
                              />
                            </Tooltip>
                          )}
                        </Box>
                      </TableCell>
                      <TableCell>
                        {streamChip === null ? (
                          <Tooltip title="No streaming trigger — this sync runs on the periodic full reconcile">
                            <Typography
                              variant="caption"
                              sx={{
                                color: "text.secondary",
                              }}
                            >
                              —
                            </Typography>
                          </Tooltip>
                        ) : (
                          <Tooltip
                            title={
                              repart?.status === "failed" && repart?.error
                                ? `Repartition failed: ${repart.error}`
                                : ""
                            }
                          >
                            <StatusPill
                              tone={pillToneForMuiColor(streamChip.color)}
                            >
                              {streamChip.label}
                            </StatusPill>
                          </Tooltip>
                        )}
                      </TableCell>
                      <TableCell>
                        <Box
                          sx={{
                            display: "flex",
                            alignItems: "center",
                            gap: 0.75,
                          }}
                        >
                          <StatusPill
                            tone={pillToneForMuiColor(backfillChip.color)}
                          >
                            {backfillChip.label}
                          </StatusPill>
                          {e.execStatus === "syncing" && (
                            <Typography
                              variant="caption"
                              sx={{
                                color: "text.secondary",
                                fontSize: "0.68rem",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {syncingRowsWritten.toLocaleString()} written
                            </Typography>
                          )}
                        </Box>
                      </TableCell>
                      <TableCell align="right">
                        <Typography
                          color={
                            destinationRows === null
                              ? "text.secondary"
                              : undefined
                          }
                          sx={{
                            fontSize: "0.8rem",
                            fontWeight: (destinationRows ?? 0) > 0 ? 600 : 400,
                          }}
                        >
                          {destinationRows === null
                            ? "—"
                            : destinationRows.toLocaleString()}
                        </Typography>
                      </TableCell>
                      <TableCell align="right">
                        <Typography
                          sx={{
                            fontSize: "0.8rem",
                            fontWeight: eventCount > 0 ? 600 : 400,
                          }}
                        >
                          {eventCount.toLocaleString()}
                        </Typography>
                      </TableCell>
                      <TableCell align="right">
                        <Box
                          sx={{
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "flex-end",
                            gap: 0.25,
                          }}
                        >
                          {bfStatus !== "running" && (
                            <>
                              <Tooltip
                                title={`Reset table and rebackfill ${entityLabel(e.entity)}`}
                              >
                                <IconButton
                                  size="small"
                                  onClick={ev => {
                                    ev.stopPropagation();
                                    openEntityResetDialog(e.entity);
                                  }}
                                  disabled={busy}
                                  sx={{ p: 0.25 }}
                                >
                                  <ResetTableIcon sx={{ fontSize: 16 }} />
                                </IconButton>
                              </Tooltip>
                              <Tooltip title={`Sync ${entityLabel(e.entity)}`}>
                                <IconButton
                                  size="small"
                                  onClick={ev => {
                                    ev.stopPropagation();
                                    handleStartBackfill([e.entity]);
                                  }}
                                  disabled={busy}
                                  sx={{ p: 0.25 }}
                                >
                                  <BackfillIcon sx={{ fontSize: 16 }} />
                                </IconButton>
                              </Tooltip>
                            </>
                          )}
                        </Box>
                      </TableCell>
                    </TableRow>
                    {isExpanded && (
                      <TableRow key={`${e.entity}-schema`}>
                        <TableCell
                          colSpan={6}
                          sx={{
                            py: 0,
                            px: 0,
                            borderBottom: "none",
                          }}
                        >
                          {schemaData?.loading ? (
                            <Box sx={{ py: 1.5, px: 2 }}>
                              <LinearProgress
                                sx={{ height: 2, borderRadius: 1 }}
                              />
                            </Box>
                          ) : schemaData?.fields &&
                            Object.keys(schemaData.fields).length > 0 ? (
                            <Box
                              sx={{
                                mx: 2,
                                my: 1.5,
                                border: 1,
                                borderColor: "divider",
                                borderRadius: 1,
                                overflow: "hidden",
                              }}
                            >
                              <Box
                                sx={{
                                  px: 1.5,
                                  py: 0.75,
                                  bgcolor: "action.hover",
                                  borderBottom: 1,
                                  borderColor: "divider",
                                  display: "flex",
                                  alignItems: "center",
                                  justifyContent: "space-between",
                                }}
                              >
                                <Typography
                                  sx={{
                                    fontSize: "0.7rem",
                                    fontWeight: 600,
                                    color: "text.secondary",
                                    textTransform: "uppercase",
                                    letterSpacing: 0.5,
                                  }}
                                >
                                  Schema
                                </Typography>
                                <Chip
                                  label={`${Object.keys(schemaData.fields).length} columns`}
                                  size="small"
                                  sx={{
                                    height: 18,
                                    fontSize: "0.62rem",
                                    fontWeight: 600,
                                  }}
                                />
                              </Box>
                              <Box>
                                {Object.entries(schemaData.fields).map(
                                  ([fieldName, fieldDef]) => (
                                    <Box
                                      key={fieldName}
                                      sx={{
                                        display: "flex",
                                        alignItems: "center",
                                        justifyContent: "space-between",
                                        gap: 1,
                                        px: 1.5,
                                        py: 0.5,
                                        borderBottom: 1,
                                        borderColor: "divider",
                                        "&:hover": {
                                          bgcolor: "action.hover",
                                        },
                                      }}
                                    >
                                      <Typography
                                        sx={{
                                          fontFamily: "monospace",
                                          fontSize: "0.72rem",
                                          fontWeight: fieldDef.required
                                            ? 600
                                            : 400,
                                          color: fieldName.startsWith("_mako_")
                                            ? "text.disabled"
                                            : "text.primary",
                                          overflow: "hidden",
                                          textOverflow: "ellipsis",
                                          whiteSpace: "nowrap",
                                        }}
                                      >
                                        {fieldName}
                                      </Typography>
                                      <Chip
                                        label={fieldDef.type}
                                        size="small"
                                        variant="outlined"
                                        color={
                                          fieldDef.type === "timestamp"
                                            ? "info"
                                            : fieldDef.type === "number"
                                              ? "warning"
                                              : fieldDef.type === "boolean"
                                                ? "success"
                                                : fieldDef.type === "json"
                                                  ? "secondary"
                                                  : "default"
                                        }
                                        sx={{
                                          height: 18,
                                          fontSize: "0.6rem",
                                          fontWeight: 600,
                                          flexShrink: 0,
                                          minWidth: 52,
                                          justifyContent: "center",
                                        }}
                                      />
                                    </Box>
                                  ),
                                )}
                              </Box>
                            </Box>
                          ) : (
                            <Typography
                              variant="caption"
                              sx={{
                                color: "text.secondary",
                                py: 1.5,
                                px: 2,
                                display: "block",
                              }}
                            >
                              No schema available for this entity
                            </Typography>
                          )}
                        </TableCell>
                      </TableRow>
                    )}
                  </React.Fragment>
                );
              })}
            </TableBody>
          </Table>
        </BorderedTableContainer>
      )}
    </Box>
  );
}
