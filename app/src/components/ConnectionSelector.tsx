import { useCallback, useEffect, useMemo } from "react";
import {
  Box,
  Typography,
  Autocomplete,
  TextField,
  CircularProgress,
} from "@mui/material";
import { Storage as DatabaseIcon } from "@mui/icons-material";
import { useSchemaStore, Connection } from "../store/schemaStore";
import { useDatabaseCatalogStore } from "../store/databaseCatalogStore";
import { useWorkspace } from "../contexts/workspace-context";

interface ConnectionSelectorProps {
  /** Currently selected connection ID */
  value: string;
  /** Callback when connection changes */
  onChange: (connectionId: string) => void;
  /** Label text (optional) */
  label?: string;
  /** Placeholder text */
  placeholder?: string;
  /** Whether the selector is disabled */
  disabled?: boolean;
  /** Error state */
  error?: boolean;
  /** Helper text */
  helperText?: string;
  /** Size variant - "compact" for toolbar use, "normal" for forms */
  size?: "compact" | "normal";
  /** Whether to show the label */
  showLabel?: boolean;
  /** Custom width */
  width?: number | string;
  /** Full width mode for forms */
  fullWidth?: boolean;
}

/**
 * Shared connection selector component with database type icons.
 * Used in Console toolbar, DbFlowForm, and other places that need connection selection.
 */
export function ConnectionSelector({
  value,
  onChange,
  label = "Connection",
  placeholder = "Select connection",
  disabled = false,
  error = false,
  helperText,
  size = "normal",
  showLabel = true,
  width,
  fullWidth = false,
}: ConnectionSelectorProps) {
  const { currentWorkspace } = useWorkspace();

  // Get connections from schema store
  const connectionsMap = useSchemaStore(state => state.connections);
  const loadingMap = useSchemaStore(state => state.loading);
  const ensureConnections = useSchemaStore(state => state.ensureConnections);

  const connections = useMemo(
    () => (currentWorkspace ? connectionsMap[currentWorkspace.id] || [] : []),
    [currentWorkspace, connectionsMap],
  );

  const isLoading = currentWorkspace
    ? !!loadingMap[`connections:${currentWorkspace.id}`]
    : false;

  // Database type icons
  const { types: dbTypes, fetchTypes } = useDatabaseCatalogStore();

  useEffect(() => {
    fetchTypes().catch(() => undefined);
  }, [fetchTypes]);

  useEffect(() => {
    if (currentWorkspace?.id) {
      ensureConnections(currentWorkspace.id);
    }
  }, [currentWorkspace?.id, ensureConnections]);

  const typeToIconUrl = useCallback(
    (type: string): string | null => {
      const meta = (dbTypes || []).find(t => t.type === type);
      return meta?.iconUrl || null;
    },
    [dbTypes],
  );

  const selectedConnection = useMemo(
    () => connections.find(c => c.id === value) || null,
    [connections, value],
  );

  const isCompact = size === "compact";

  return (
    <Autocomplete
      options={connections}
      loading={isLoading}
      disabled={disabled}
      size="small"
      fullWidth={fullWidth}
      noOptionsText={isLoading ? "Loading..." : "No connections found"}
      getOptionLabel={(option: Connection) =>
        option.name || option.displayName || ""
      }
      value={selectedConnection}
      onChange={(_, newValue) => {
        onChange(newValue?.id || "");
      }}
      isOptionEqualToValue={(option, val) => option.id === val?.id}
      renderOption={(props, option) => {
        const { key, ...otherProps } = props;
        const iconUrl = typeToIconUrl(option.type);
        return (
          <Box
            component="li"
            key={key}
            {...otherProps}
            sx={{
              display: "flex",
              alignItems: "center",
              gap: 0.75,
              py: 0.5,
              px: 1,
              minHeight: isCompact ? 28 : 32,
            }}
          >
            {iconUrl ? (
              <img
                src={iconUrl}
                alt={option.type}
                style={{
                  width: 16,
                  height: 16,
                  display: "block",
                  flexShrink: 0,
                }}
              />
            ) : (
              <DatabaseIcon
                sx={{
                  width: 16,
                  height: 16,
                  flexShrink: 0,
                  color: "text.secondary",
                }}
              />
            )}
            <Typography
              variant="body2"
              sx={{
                fontSize: "0.8125rem",
                fontWeight: 400,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {option.name || option.displayName}
            </Typography>
          </Box>
        );
      }}
      renderInput={params => (
        <TextField
          {...params}
          label={showLabel ? label : undefined}
          placeholder={placeholder}
          error={error}
          helperText={helperText}
          variant={isCompact ? "standard" : "outlined"}
          slotProps={{
            input: {
              ...params.InputProps,
              disableUnderline: isCompact,
              startAdornment: value ? (
                <Box
                  sx={{
                    display: "flex",
                    alignItems: "center",
                    flexShrink: 0,
                  }}
                >
                  {(() => {
                    const conn = connections.find(c => c.id === value);
                    const iconUrl = conn ? typeToIconUrl(conn.type) : null;
                    return iconUrl ? (
                      <img
                        src={iconUrl}
                        alt={conn?.type}
                        style={{
                          width: 16,
                          height: 16,
                          display: "block",
                        }}
                      />
                    ) : (
                      <DatabaseIcon
                        sx={{
                          width: 16,
                          height: 16,
                          color: "text.secondary",
                        }}
                      />
                    );
                  })()}
                </Box>
              ) : null,
              endAdornment: (
                <>
                  {isLoading ? (
                    <CircularProgress color="inherit" size={14} />
                  ) : null}
                  {params.InputProps.endAdornment}
                </>
              ),
            },
            htmlInput: {
              ...params.inputProps,
              style: {
                ...params.inputProps?.style,
                fontSize: "0.8125rem",
                padding: isCompact ? "2px 0" : undefined,
              },
            },
          }}
          sx={{
            minWidth: fullWidth ? undefined : width || (isCompact ? 100 : 200),
            width: fullWidth ? "100%" : undefined,
            m: isCompact ? 0 : undefined, // No margin in compact mode
            "& .MuiInputBase-root": {
              fontSize: "0.8125rem",
              minHeight: isCompact ? 28 : undefined,
              gap: 0.75, // 6px gap between icon and text, matching dropdown options
              mt: isCompact ? 0 : undefined,
            },
            "& .MuiInputBase-input": {
              py: isCompact ? 0.25 : undefined,
              pl: "0 !important", // Remove left padding, gap handles spacing
            },
            "& .MuiAutocomplete-endAdornment": {
              right: isCompact ? 0 : 9,
            },
            "& .MuiSvgIcon-root": {
              fontSize: isCompact ? "1rem" : "1.25rem",
            },
            // Remove TextField's default margin in compact mode
            "& .MuiFormControl-root": {
              m: isCompact ? 0 : undefined,
            },
          }}
        />
      )}
      sx={{
        minWidth: fullWidth ? undefined : width || (isCompact ? 100 : 200),
        width: fullWidth ? "100%" : undefined,
        "& .MuiAutocomplete-inputRoot": {
          py: isCompact ? 0 : undefined,
          pl: isCompact ? 0 : undefined,
        },
        // Remove all margin in compact mode for toolbar usage
        "& .MuiTextField-root": {
          m: isCompact ? 0 : undefined,
        },
        "& .MuiInput-root": {
          mt: isCompact ? "0 !important" : undefined,
        },
      }}
    />
  );
}

export default ConnectionSelector;
