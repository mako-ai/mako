import {
  TextField,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Box,
  Switch,
  FormControlLabel,
  CircularProgress,
  IconButton,
  Tooltip,
} from "@mui/material";
import { Visibility, VisibilityOff } from "@mui/icons-material";
import { Controller, UseFormReturn } from "react-hook-form";
import { type ConnectorFieldSchema } from "./source-connection-schema";
import { ObjectArrayField } from "./ObjectArrayField";
import type { SourceConnectionFormModel } from "./useSourceConnectionForm";

/** One schema-driven connector config field (text, secret, select, boolean, …). */
export function DynamicField({
  field,
  form,
  model,
}: {
  field: ConnectorFieldSchema;
  form: UseFormReturn<any>;
  model: SourceConnectionFormModel;
}) {
  const {
    decryptedValues,
    decryptingFields,
    showDecryptedFields,
    readOnly,
    revealSecret,
    toggleDecryptedVisibility,
    getDisplayValue,
  } = model;
  const { control } = form;
  const {
    name,
    label,
    type,
    required,
    helperText,
    placeholder,
    options,
    rows,
    encrypted,
  } = field;
  const fieldType = type === "password" ? "password" : "text";

  // Revealing a key is a manager's act: no eye on a read-only form.
  const shouldShowDecrypt =
    !readOnly && (encrypted === true || type === "password");

  const isNested = name.includes(".");

  if (type === "boolean") {
    return (
      <Controller
        key={name}
        name={name}
        control={control}
        rules={{ required }}
        render={({ field }) => (
          <FormControlLabel
            control={
              <Switch
                {...field}
                checked={field.value ?? false}
                disabled={readOnly}
              />
            }
            label={label}
          />
        )}
      />
    );
  }

  if (options && options.length > 0) {
    return (
      <Controller
        key={name}
        name={name}
        control={control}
        rules={{ required }}
        render={({ field }) => (
          <FormControl fullWidth margin="normal" variant="outlined">
            <InputLabel>{label}</InputLabel>
            <Select {...field} label={label} disabled={readOnly}>
              {options.map(opt => {
                const val =
                  typeof opt.value === "boolean"
                    ? String(opt.value)
                    : opt.value;
                return (
                  <MenuItem key={String(opt.value)} value={val}>
                    {opt.label}
                  </MenuItem>
                );
              })}
            </Select>
          </FormControl>
        )}
      />
    );
  }

  if (type === "textarea") {
    return (
      <Box
        key={name}
        sx={{
          position: "relative",
        }}
      >
        <Controller
          name={name}
          control={control}
          rules={{ required }}
          render={({ field, fieldState }) => (
            <TextField
              {...field}
              disabled={readOnly}
              fullWidth
              margin="normal"
              multiline
              rows={rows ?? 8}
              label={label}
              placeholder={placeholder}
              error={!!fieldState.error}
              helperText={
                fieldState.error ? "This field is required" : helperText
              }
              type={showDecryptedFields[name] ? "text" : fieldType}
              value={getDisplayValue(name, field.value)}
              autoComplete="false"
              name={`config_${name}`}
              slotProps={{
                input: {
                  autoComplete: "false",
                  style: { fontFamily: "monospace", fontSize: "0.875rem" },
                  ...(isNested
                    ? {}
                    : {
                        readOnly: true,
                        onFocus: (e: any) => {
                          setTimeout(() => {
                            e.target.removeAttribute("readonly");
                          }, 100);
                        },
                      }),
                  endAdornment: shouldShowDecrypt && field.value && (
                    <Box sx={{ display: "flex", gap: 0.5, mr: 1 }}>
                      <Tooltip
                        title={
                          showDecryptedFields[name]
                            ? "Hide decrypted"
                            : "Show decrypted"
                        }
                      >
                        <IconButton
                          size="small"
                          onClick={() => {
                            if (
                              !decryptedValues[name] &&
                              !showDecryptedFields[name]
                            ) {
                              revealSecret(name);
                            } else {
                              toggleDecryptedVisibility(name);
                            }
                          }}
                          disabled={decryptingFields[name]}
                        >
                          {decryptingFields[name] ? (
                            <CircularProgress size={20} />
                          ) : showDecryptedFields[name] ? (
                            <VisibilityOff />
                          ) : (
                            <Visibility />
                          )}
                        </IconButton>
                      </Tooltip>
                    </Box>
                  ),
                },
              }}
            />
          )}
        />
      </Box>
    );
  }

  if (field.type === "object_array") {
    return (
      <ObjectArrayField
        key={field.name}
        field={field}
        form={form}
        readOnly={readOnly}
      />
    );
  }

  return (
    <Box
      key={name}
      sx={{
        position: "relative",
      }}
    >
      <Controller
        name={name}
        control={control}
        rules={{ required }}
        render={({ field, fieldState }) => (
          <TextField
            {...field}
            disabled={readOnly}
            fullWidth
            margin="normal"
            type={showDecryptedFields[name] ? "text" : fieldType}
            value={getDisplayValue(name, field.value)}
            label={label}
            placeholder={placeholder}
            error={!!fieldState.error}
            helperText={
              fieldState.error ? "This field is required" : helperText
            }
            name={`config_${name}`}
            slotProps={{
              input: {
                endAdornment: shouldShowDecrypt && field.value && (
                  <Box sx={{ display: "flex", gap: 0.5, mr: 1 }}>
                    <Tooltip
                      title={
                        showDecryptedFields[name]
                          ? "Hide decrypted"
                          : "Show decrypted"
                      }
                    >
                      <IconButton
                        size="small"
                        onClick={() => {
                          if (
                            !decryptedValues[name] &&
                            !showDecryptedFields[name]
                          ) {
                            revealSecret(name);
                          } else {
                            toggleDecryptedVisibility(name);
                          }
                        }}
                        disabled={decryptingFields[name]}
                      >
                        {decryptingFields[name] ? (
                          <CircularProgress size={20} />
                        ) : showDecryptedFields[name] ? (
                          <VisibilityOff />
                        ) : (
                          <Visibility />
                        )}
                      </IconButton>
                    </Tooltip>
                  </Box>
                ),
              },
            }}
          />
        )}
      />
    </Box>
  );
}
