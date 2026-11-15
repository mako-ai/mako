import { Controller } from "react-hook-form";
import {
  Box,
  Checkbox,
  Chip,
  MenuItem,
  Select,
  Tooltip,
  Typography,
} from "@mui/material";
import {
  SYSTEM_ENTITY_FIELDS,
  INCREMENTAL_MODE_BADGE,
} from "./sync-flow-config";
import type { SyncFlowFormModel } from "./useSyncFlowForm";

export function SyncEntityTable({ model }: { model: SyncFlowFormModel }) {
  const {
    entityMetadata,
    formTouchedRef,
    control,
    getValues,
    setValue,
    watchEntityLayouts,
    incrementalCheckEntities,
    incrementalWarning,
    layoutMode,
    entityGridTemplate,
  } = model;
  return (
    <>
      {/* Entity selection (fixed + hybrid connectors with builtins) */}
      {watchEntityLayouts.length > 0 && (
        <Box>
          <Typography variant="subtitle2" sx={{ mb: 1 }}>
            Entities
            {layoutMode === "partition"
              ? " & Table Configuration"
              : layoutMode === "index"
                ? " & Index Configuration"
                : ""}
          </Typography>
          <Box
            sx={{
              border: 1,
              borderColor: "divider",
              borderRadius: 1,
              overflowX: "auto",
            }}
          >
            <Box sx={{ minWidth: layoutMode === "none" ? 0 : 720 }}>
              <Box
                sx={{
                  display: "grid",
                  gridTemplateColumns: entityGridTemplate,
                  gap: 1,
                  px: 1,
                  py: 0.5,
                  bgcolor: "action.hover",
                  alignItems: "center",
                }}
              >
                <Checkbox
                  size="small"
                  checked={watchEntityLayouts.every(l => l.enabled !== false)}
                  indeterminate={
                    watchEntityLayouts.some(l => l.enabled !== false) &&
                    !watchEntityLayouts.every(l => l.enabled !== false)
                  }
                  onChange={e => {
                    formTouchedRef.current = true;
                    const layouts = getValues("entityLayouts") || [];
                    setValue(
                      "entityLayouts",
                      layouts.map(l => ({
                        ...l,
                        enabled: e.target.checked,
                      })),
                      { shouldDirty: true },
                    );
                  }}
                />
                <Typography
                  variant="caption"
                  sx={{
                    fontWeight: "bold",
                  }}
                >
                  Entity{layoutMode !== "none" ? " Table" : ""}
                </Typography>
                <Typography
                  variant="caption"
                  sx={{
                    fontWeight: "bold",
                  }}
                >
                  Primary Key
                </Typography>
                <Typography
                  variant="caption"
                  sx={{
                    fontWeight: "bold",
                  }}
                >
                  Sync
                </Typography>
                {layoutMode === "partition" && (
                  <>
                    <Typography
                      variant="caption"
                      sx={{
                        fontWeight: "bold",
                      }}
                    >
                      Partition Field
                    </Typography>
                    <Typography
                      variant="caption"
                      sx={{
                        fontWeight: "bold",
                      }}
                    >
                      Granularity
                    </Typography>
                    <Typography
                      variant="caption"
                      sx={{
                        fontWeight: "bold",
                      }}
                    >
                      Cluster Fields
                    </Typography>
                  </>
                )}
                {layoutMode === "index" && (
                  <>
                    <Typography
                      variant="caption"
                      sx={{
                        fontWeight: "bold",
                      }}
                    >
                      Time Field (indexed)
                    </Typography>
                    <Typography
                      variant="caption"
                      sx={{
                        fontWeight: "bold",
                      }}
                    >
                      Indexed Fields
                    </Typography>
                  </>
                )}
              </Box>
              {watchEntityLayouts.map((layout, idx) => {
                const entityMeta = entityMetadata.find(
                  e => e.name === layout.entity,
                );
                const schemaFields = entityMeta?.fields ?? [];
                const entityFields =
                  schemaFields.length > 0
                    ? schemaFields.map(f => f.name)
                    : SYSTEM_ENTITY_FIELDS;
                const timestampFields =
                  schemaFields.length > 0
                    ? schemaFields
                        .filter(f => f.type === "timestamp")
                        .map(f => f.name)
                    : ["_syncedAt"];
                if (!timestampFields.includes("_syncedAt")) {
                  timestampFields.push("_syncedAt");
                }
                const isEnabled = layout.enabled !== false;
                const keyColumns = entityMeta?.keyColumns ?? ["id"];
                const incrementalBadge = entityMeta?.incrementalMode
                  ? INCREMENTAL_MODE_BADGE[entityMeta.incrementalMode]
                  : undefined;
                return (
                  <Box
                    key={layout.entity}
                    sx={{
                      display: "grid",
                      gridTemplateColumns: entityGridTemplate,
                      gap: 1,
                      px: 1,
                      py: 0.5,
                      borderTop: 1,
                      borderColor: "divider",
                      alignItems: "center",
                      opacity: isEnabled ? 1 : 0.4,
                    }}
                  >
                    <Checkbox
                      size="small"
                      checked={isEnabled}
                      onChange={e => {
                        formTouchedRef.current = true;
                        const layouts = getValues("entityLayouts") || [];
                        setValue(
                          "entityLayouts",
                          layouts.map((l, i) =>
                            i === idx ? { ...l, enabled: e.target.checked } : l,
                          ),
                          { shouldDirty: true },
                        );
                      }}
                    />
                    <Typography variant="body2">
                      {layout.label || layout.entity}
                    </Typography>
                    <Tooltip
                      title={`Rows are deduplicated/merged on ${keyColumns.join(", ")}. Set by the connector — not user-configurable today.`}
                    >
                      <Typography
                        variant="caption"
                        sx={{
                          color: "text.secondary",
                          fontFamily: "monospace",
                        }}
                      >
                        {keyColumns.join(", ")}
                      </Typography>
                    </Tooltip>
                    {incrementalBadge ? (
                      <Tooltip
                        title={
                          incrementalCheckEntities.includes(layout.entity) &&
                          incrementalWarning
                            ? incrementalWarning
                            : `Incremental capability for this entity: ${entityMeta?.incrementalMode}`
                        }
                      >
                        <Chip
                          size="small"
                          variant="outlined"
                          label={incrementalBadge.label}
                          color={incrementalBadge.color}
                        />
                      </Tooltip>
                    ) : (
                      <Typography
                        variant="caption"
                        sx={{
                          color: "text.secondary",
                        }}
                      >
                        —
                      </Typography>
                    )}
                    {layoutMode !== "none" && (
                      <>
                        <Controller
                          name={`entityLayouts.${idx}.partitionField`}
                          control={control}
                          render={({ field }) => (
                            <Select
                              {...field}
                              size="small"
                              value={field.value || "_syncedAt"}
                              disabled={!isEnabled}
                            >
                              {timestampFields.map(f => (
                                <MenuItem key={f} value={f}>
                                  {f}
                                </MenuItem>
                              ))}
                            </Select>
                          )}
                        />
                        {layoutMode === "partition" && (
                          <Controller
                            name={`entityLayouts.${idx}.partitionGranularity`}
                            control={control}
                            render={({ field }) => (
                              <Select
                                {...field}
                                size="small"
                                value={field.value || "day"}
                                disabled={!isEnabled}
                              >
                                <MenuItem value="hour">hour</MenuItem>
                                <MenuItem value="day">day</MenuItem>
                                <MenuItem value="month">month</MenuItem>
                                <MenuItem value="year">year</MenuItem>
                              </Select>
                            )}
                          />
                        )}
                        <Controller
                          name={`entityLayouts.${idx}.clusterFields`}
                          control={control}
                          render={({ field }) => (
                            <Select
                              multiple
                              size="small"
                              value={field.value || []}
                              disabled={!isEnabled}
                              onChange={e =>
                                field.onChange(
                                  typeof e.target.value === "string"
                                    ? e.target.value.split(",")
                                    : e.target.value,
                                )
                              }
                              renderValue={selected => (
                                <Box
                                  sx={{
                                    display: "flex",
                                    flexWrap: "wrap",
                                    gap: 0.5,
                                  }}
                                >
                                  {(selected as string[]).map(val => (
                                    <Chip key={val} label={val} size="small" />
                                  ))}
                                </Box>
                              )}
                              displayEmpty
                            >
                              {entityFields.map(f => (
                                <MenuItem key={f} value={f}>
                                  {f}
                                </MenuItem>
                              ))}
                            </Select>
                          )}
                        />
                      </>
                    )}
                  </Box>
                );
              })}
            </Box>
          </Box>
        </Box>
      )}
    </>
  );
}
