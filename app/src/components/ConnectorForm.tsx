import { useEffect, useState, useMemo, useRef } from "react";
import {
  Button,
  TextField,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Box,
  Typography,
  Switch,
  FormControlLabel,
  Alert,
  CircularProgress,
  IconButton,
  Tooltip,
  Snackbar,
} from "@mui/material";
import {
  Visibility,
  VisibilityOff,
  Delete as DeleteIcon,
} from "@mui/icons-material";

import {
  useForm,
  Controller,
  UseFormReturn,
  useFieldArray,
} from "react-hook-form";

// Zustand stores
import { useConnectorStore } from "../store/connectorStore";
import { useConnectorCatalogStore } from "../store/connectorCatalogStore";

export interface ConnectorFieldSchema {
  name: string;
  label: string;
  type:
    | "string"
    | "number"
    | "boolean"
    | "password"
    | "textarea"
    | "object_array"
    | "select";
  required?: boolean;
  default?: unknown;
  helperText?: string;
  placeholder?: string;
  options?: Array<{ label: string; value: string | number | boolean }>;
  rows?: number;
  encrypted?: boolean;
  showIf?: {
    field: string;
    equals?: string | number | boolean | Array<string | number | boolean>;
    notEquals?: string | number | boolean | Array<string | number | boolean>;
  };
  itemFields?: ConnectorFieldSchema[];
}

export interface ConnectorSchemaResponse {
  fields: ConnectorFieldSchema[];
}

interface ConnectorFormProps {
  tabId?: string;
  variant?: "dialog" | "inline";
  open?: boolean;
  onClose?: () => void;
  onSubmit: (data: any) => void;
  connector?: any | null;
  connectorTypes?: Array<{
    type: string;
    name: string;
    version: string;
    description: string;
    supportedEntities: string[];
  }>;
  errorMessage?: string | null;
  onDirtyChange?: (dirty: boolean) => void;
  onTitleChange?: (title: string) => void;
}

function generateDefaultValues(
  schema?: ConnectorSchemaResponse,
): Record<string, any> {
  if (!schema) return {};
  const defaults: Record<string, any> = {};
  schema.fields.forEach(f => {
    if (f.default !== undefined) {
      defaults[f.name] = f.default;
    } else if (f.type === "boolean") {
      defaults[f.name] = false;
    } else if (f.type === "object_array") {
      defaults[f.name] = [];
    } else {
      defaults[f.name] = "";
    }
  });
  return defaults;
}

function ConnectorForm({
  onClose,
  onSubmit,
  connector,
  connectorTypes = [],
  errorMessage,
  tabId,
  onDirtyChange,
}: ConnectorFormProps) {
  const [schema, setSchema] = useState<ConnectorSchemaResponse | null>(null);
  const [schemaLoading, setSchemaLoading] = useState(false);
  const [schemaError, setSchemaError] = useState<string | null>(null);

  const [decryptedValues, setDecryptedValues] = useState<
    Record<string, string>
  >({});
  const [decryptingFields, setDecryptingFields] = useState<
    Record<string, boolean>
  >({});
  const [showDecryptedFields, setShowDecryptedFields] = useState<
    Record<string, boolean>
  >({});
  const [snackbarMessage, setSnackbarMessage] = useState<string | null>(null);

  const draftRef = useRef<Record<string, any> | undefined>(
    tabId ? useConnectorStore.getState().drafts[tabId]?.values : undefined,
  );
  useEffect(() => {
    if (tabId) {
      draftRef.current = useConnectorStore.getState().drafts[tabId]?.values;
    }
  }, [tabId]);

  const defaultValues = useMemo(() => {
    let base: Record<string, any>;
    if (connector) {
      base = {
        name: connector.name || "",
        description: connector.description || "",
        type: connector.type || "",
        isActive: connector.isActive ?? true,
        ...connector.config,
        settings_sync_batch_size: connector.settings?.sync_batch_size ?? 100,
        settings_rate_limit_delay_ms:
          connector.settings?.rate_limit_delay_ms ?? 200,
        settings_max_retries: connector.settings?.max_retries ?? 3,
        settings_timeout_ms: connector.settings?.timeout_ms ?? 30000,
      };
    } else {
      base = {
        name: "",
        description: "",
        type: "",
        isActive: true,
        // Sensible defaults to satisfy required validation
        settings_sync_batch_size: 100,
        settings_rate_limit_delay_ms: 200,
        settings_max_retries: 3,
        settings_timeout_ms: 30000,
      };
    }

    if (draftRef.current) {
      base = { ...base, ...draftRef.current };
    }

    const deepClone = (obj: any): any => {
      if (obj === null || typeof obj !== "object") return obj;
      if (obj instanceof Date) return new Date(obj);
      if (Array.isArray(obj)) {
        return obj.map(item => deepClone(item));
      }
      const cloned: Record<string, any> = {};
      for (const key in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
          cloned[key] = deepClone(obj[key]);
        }
      }
      return cloned;
    };

    return deepClone(base);
  }, [connector]);

  const form = useForm({
    defaultValues,
    mode: "onChange",
    shouldUnregister: false,
  });

  const {
    control,
    handleSubmit,
    watch,
    reset,
    formState: { errors, isDirty },
  } = form;

  const selectedType = watch("type");

  useEffect(() => {
    if (connector) {
      const mutableDefaults = JSON.parse(JSON.stringify(defaultValues));
      reset(mutableDefaults);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connector?._id]);

  const { schemas, fetchSchema } = useConnectorCatalogStore();

  useEffect(() => {
    if (!selectedType) {
      setSchema(null);
      return;
    }
    if (schemas[selectedType]) {
      setSchema(schemas[selectedType]);
      const currentValues = form.getValues();
      schemas[selectedType].fields.forEach((field: ConnectorFieldSchema) => {
        if (field.type === "object_array" && !currentValues[field.name]) {
          form.setValue(field.name, []);
        }
      });
      return;
    }
    setSchemaLoading(true);
    setSchemaError(null);
    fetchSchema(selectedType).then(res => {
      if (res) {
        setSchema(res);
        const defaults = generateDefaultValues(res);
        Object.entries(defaults).forEach(([key, value]) => {
          if (form.getValues(key) === undefined) {
            const mutableValue = Array.isArray(value) ? [...value] : value;
            form.setValue(key, mutableValue);
          }
        });
      } else {
        setSchemaError("Failed to load connector schema");
      }
      setSchemaLoading(false);
    });
  }, [selectedType, schemas, fetchSchema, form]);

  const decryptValue = async (fieldName: string, encryptedValue: string) => {
    if (!encryptedValue) {
      setSnackbarMessage("No value to decrypt");
      return;
    }

    setDecryptingFields(prev => ({ ...prev, [fieldName]: true }));

    try {
      const workspaceId = connector?.workspaceId || "default";

      const response = await fetch(
        `/api/workspaces/${workspaceId}/connectors/decrypt`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ encryptedValue }),
        },
      );

      const result = await response.json();

      if (result.success) {
        setDecryptedValues(prev => ({
          ...prev,
          [fieldName]: result.data.decryptedValue,
        }));
        setShowDecryptedFields(prev => ({
          ...prev,
          [fieldName]: true,
        }));

        if (!result.data.wasEncrypted) {
          setSnackbarMessage("Value was not encrypted");
        }
      } else {
        setSnackbarMessage(result.error || "Failed to decrypt value");
      }
    } catch (error) {
      console.error("Decrypt error:", error);
      setSnackbarMessage("Failed to decrypt value");
    } finally {
      setDecryptingFields(prev => ({ ...prev, [fieldName]: false }));
    }
  };

  const toggleDecryptedVisibility = (fieldName: string) => {
    setShowDecryptedFields(prev => ({
      ...prev,
      [fieldName]: !prev[fieldName],
    }));
  };

  const onSubmitInternal = (values: Record<string, unknown>) => {
    // form submitted
    const { dirtyFields } = form.formState;
    // Validate object_array required items before proceeding
    if (schema) {
      let hasItemErrors = false;
      schema.fields.forEach(f => {
        if (f.type === "object_array" && Array.isArray(f.itemFields)) {
          const items: Record<string, unknown>[] = Array.isArray(values[f.name])
            ? (values[f.name] as Record<string, unknown>[])
            : [];
          if (f.required && items.length === 0) {
            form.setError(f.name, {
              type: "required",
              message: "At least one item is required",
            });
            hasItemErrors = true;
          }
          items.forEach((item, idx) => {
            f.itemFields!.forEach(sub => {
              if (sub.required) {
                const v = item?.[sub.name as keyof typeof item];
                const isEmpty =
                  v === undefined ||
                  v === null ||
                  (typeof v === "string" && v.trim() === "");
                if (isEmpty) {
                  const path = `${f.name}.${idx}.${sub.name}`;
                  form.setError(path, {
                    type: "required",
                    message: "This field is required",
                  });
                  hasItemErrors = true;
                }
              }
            });
          });
        }
      });
      if (hasItemErrors) {
        setSnackbarMessage(
          "Please complete all required fields in queries before saving.",
        );
        return;
      }
    }

    const isNewConnector = !connector;

    const isFieldDirty = (fieldName: string): boolean => {
      if (dirtyFields[fieldName]) return true;
      const fieldPrefix = fieldName + ".";
      return Object.keys(dirtyFields).some(key => key.startsWith(fieldPrefix));
    };

    const payload: Record<string, unknown> = {};

    if (isNewConnector || dirtyFields.type) {
      payload.type = values.type;
    }

    if (isNewConnector || dirtyFields.name) {
      payload.name = values.name;
    }
    if (isNewConnector || dirtyFields.description) {
      payload.description = values.description;
    }
    if (isNewConnector || dirtyFields.isActive) {
      payload.isActive = values.isActive;
    }

    const config: Record<string, unknown> = {};
    let hasConfigChanges = false;

    if (schema) {
      schema.fields.forEach(f => {
        if (isNewConnector || isFieldDirty(f.name)) {
          config[f.name] = values[f.name];
          hasConfigChanges = true;
        }
      });
    }

    if (hasConfigChanges) {
      payload.config = config;
    }

    const settings: Record<string, number> = {};
    let hasSettingsChanges = false;

    const settingsFields = [
      "settings_sync_batch_size",
      "settings_rate_limit_delay_ms",
      "settings_max_retries",
      "settings_timeout_ms",
    ];

    settingsFields.forEach(field => {
      if (isNewConnector || dirtyFields[field]) {
        const key = field.replace("settings_", "");
        settings[key] =
          Number(values[field]) ||
          (field === "settings_sync_batch_size"
            ? 100
            : field === "settings_rate_limit_delay_ms"
              ? 200
              : field === "settings_max_retries"
                ? 3
                : 30000);
        hasSettingsChanges = true;
      }
    });

    if (hasSettingsChanges) {
      payload.settings = settings;
    }

    if (!isNewConnector && Object.keys(payload).length === 0) {
      console.warn("[ConnectorForm] no changes detected; skipping submit");
      return;
    }

    // submitting payload
    try {
      onSubmit(payload);
    } catch (err) {
      console.error("[ConnectorForm] onSubmit threw", err);
    }
  };

  const onSubmitError = (errors: Record<string, any>) => {
    console.error("[ConnectorForm] validation errors", errors);
  };

  const renderDynamicField = (
    field: ConnectorFieldSchema,
    form: UseFormReturn<any>,
  ) => {
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

    const shouldShowDecrypt = encrypted === true || type === "password";

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
              control={<Switch {...field} checked={field.value ?? false} />}
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
              <Select {...field} label={label}>
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
        <Box key={name} position="relative">
          <Controller
            name={name}
            control={control}
            rules={{ required }}
            render={({ field, fieldState }) => (
              <TextField
                {...field}
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
                value={
                  showDecryptedFields[name] && decryptedValues[name]
                    ? decryptedValues[name]
                    : field.value
                }
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
                                decryptValue(name, field.value);
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
      return <ObjectArrayField key={field.name} field={field} form={form} />;
    }

    return (
      <Box key={name} position="relative">
        <Controller
          name={name}
          control={control}
          rules={{ required }}
          render={({ field, fieldState }) => (
            <TextField
              {...field}
              fullWidth
              margin="normal"
              type={showDecryptedFields[name] ? "text" : fieldType}
              value={
                showDecryptedFields[name] && decryptedValues[name]
                  ? decryptedValues[name]
                  : field.value
              }
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
                              decryptValue(name, field.value);
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
  };

  const ObjectArrayField = ({
    field,
    form,
  }: {
    field: ConnectorFieldSchema;
    form: UseFormReturn<any>;
  }) => {
    const { control } = form;

    const {
      fields: arrayFields,
      append,
      remove,
    } = useFieldArray({ control, name: field.name });

    const createNewItem = () => {
      const newItem: Record<string, any> = {};
      field.itemFields?.forEach(subField => {
        if (subField.default !== undefined) {
          newItem[subField.name] = subField.default;
        } else if (subField.type === "boolean") {
          newItem[subField.name] = false;
        } else {
          newItem[subField.name] = "";
        }
      });
      return newItem;
    };

    return (
      <Box sx={{ mt: 2 }}>
        <Typography variant="subtitle1" fontWeight="medium" sx={{ mb: 1 }}>
          {field.label}
        </Typography>

        {arrayFields.map((item, index) => (
          <Box
            key={item.id}
            sx={{
              border: "1px solid",
              borderColor: "divider",
              borderRadius: 1,
              p: 2,
              mb: 2,
            }}
          >
            <Box sx={{ display: "flex", alignItems: "center", mb: 1, gap: 1 }}>
              <Typography variant="subtitle2" sx={{ flexGrow: 1 }}>
                {field.label} {index + 1}
              </Typography>
              <IconButton
                size="small"
                color="error"
                onClick={() => remove(index)}
              >
                <DeleteIcon fontSize="small" />
              </IconButton>
            </Box>

            {/* Reorder fields to desired sequence for REST entities */}
            {(field.itemFields || []).map(subField => {
              const fieldPath = `${field.name}.${index}.${subField.name}`;
              const registerProps = form.register(fieldPath, {
                required: subField.required,
              });
              const fieldState = form.getFieldState(fieldPath);
              const hasError = !!fieldState.error;

              const commonTextProps = {
                fullWidth: true,
                margin: "normal" as const,
                label: subField.label,
                placeholder: subField.placeholder,
                helperText: hasError
                  ? "This field is required"
                  : subField.helperText,
                defaultValue:
                  (item as Record<string, unknown>)[subField.name] ?? "",
              };

              // Generic conditional visibility via showIf
              if (subField.showIf) {
                const otherValue = form.watch(
                  `${field.name}.${index}.${subField.showIf.field}`,
                );
                const eq = subField.showIf.equals;
                const ne = subField.showIf.notEquals;
                const eqOk = Array.isArray(eq)
                  ? eq.includes(otherValue)
                  : eq === undefined || otherValue === eq;
                const neOk = Array.isArray(ne)
                  ? !ne.includes(otherValue)
                  : ne === undefined || otherValue !== ne;
                if (!(eqOk && neOk)) return null;
              }

              // No connector-specific cases here; selection handled generically below

              // Render dropdown when field is select or options are provided (e.g., HTTP Method)
              if (
                subField.type === "select" ||
                (subField.options && subField.options.length > 0)
              ) {
                return (
                  <Controller
                    key={fieldPath}
                    name={fieldPath}
                    control={control}
                    rules={{ required: subField.required }}
                    defaultValue={
                      (item as Record<string, unknown>)[subField.name] ??
                      subField.default ??
                      ""
                    }
                    render={({ field }) => (
                      <FormControl fullWidth margin="normal" variant="outlined">
                        <InputLabel>{subField.label}</InputLabel>
                        <Select {...field} label={subField.label}>
                          {(subField.options || []).map(opt => {
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

              if (subField.type === "textarea") {
                return (
                  <TextField
                    key={fieldPath}
                    {...commonTextProps}
                    multiline
                    rows={subField.rows ?? 4}
                    error={hasError}
                    required={subField.required}
                    inputRef={registerProps.ref}
                    name={registerProps.name}
                    onChange={registerProps.onChange}
                  />
                );
              }

              if (subField.type === "boolean") {
                return (
                  <FormControlLabel
                    key={fieldPath}
                    control={
                      <Switch
                        checked={Boolean(
                          (item as Record<string, unknown>)[subField.name],
                        )}
                        onChange={e =>
                          form.setValue(fieldPath, e.target.checked, {
                            shouldDirty: true,
                          })
                        }
                      />
                    }
                    label={subField.label}
                  />
                );
              }

              return (
                <TextField
                  key={fieldPath}
                  {...commonTextProps}
                  type={subField.type === "number" ? "number" : "text"}
                  error={hasError}
                  required={subField.required}
                  inputRef={registerProps.ref}
                  name={registerProps.name}
                  onChange={registerProps.onChange}
                />
              );
            })}
          </Box>
        ))}

        <Button
          variant="outlined"
          size="small"
          onClick={() => append(createNewItem())}
        >
          Add Query
        </Button>
      </Box>
    );
  };

  const typeSelect = (
    <FormControl fullWidth margin="normal">
      <InputLabel>Connector Type</InputLabel>
      <Controller
        name="type"
        control={control}
        rules={{ required: true }}
        render={({ field }) => (
          <Select {...field} variant="outlined" size="small">
            {connectorTypes.map(connector => (
              <MenuItem key={connector.type} value={connector.type}>
                <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                  <Box
                    component="img"
                    src={`/api/connectors/${connector.type}/icon.svg`}
                    alt={`${connector.type} icon`}
                    sx={{ width: 20, height: 20 }}
                  />
                  {connector.name}
                </Box>
              </MenuItem>
            ))}
          </Select>
        )}
      />
      {errors.type && (
        <Typography variant="caption" color="error" sx={{ ml: 2 }}>
          Connector type is required
        </Typography>
      )}
    </FormControl>
  );

  const basicInformationSection = (
    <Box sx={{ mb: 3 }}>
      <Controller
        name="name"
        control={control}
        rules={{ required: true }}
        render={({ field, fieldState }) => (
          <TextField
            {...field}
            fullWidth
            margin="normal"
            label="Name"
            error={!!fieldState.error}
            helperText={fieldState.error ? "Name is required" : undefined}
            name="connector_title"
          />
        )}
      />
    </Box>
  );

  const connectionConfigSection = (
    <>
      {schemaLoading && (
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <CircularProgress size={20} />
          <Typography variant="body2">Loading schema…</Typography>
        </Box>
      )}
      {schemaError && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {schemaError}
        </Alert>
      )}
      {schema && schema.fields.map(f => renderDynamicField(f, form))}
      {!schemaLoading && !schema && (
        <Typography color="text.secondary" sx={{ mt: 2 }}>
          Select a connector type to load configuration fields.
        </Typography>
      )}
    </>
  );

  const advancedSettingsSection = (
    <Box
      sx={{
        display: "grid",
        gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" },
        gap: 2,
      }}
    >
      <Box>
        <Controller
          name="settings_sync_batch_size"
          control={control}
          rules={{ min: 1, required: true }}
          render={({ field, fieldState }) => (
            <TextField
              {...field}
              fullWidth
              label="Sync Batch Size"
              type="number"
              margin="normal"
              error={!!fieldState.error}
              helperText={
                fieldState.error ? "Must be at least 1" : "Records per batch"
              }
            />
          )}
        />
      </Box>
      <Box>
        <Controller
          name="settings_rate_limit_delay_ms"
          control={control}
          rules={{ min: 0, required: true }}
          render={({ field, fieldState }) => (
            <TextField
              {...field}
              fullWidth
              label="Rate Limit Delay (ms)"
              type="number"
              margin="normal"
              error={!!fieldState.error}
              helperText={
                fieldState.error
                  ? "Cannot be negative"
                  : "Delay between API calls"
              }
            />
          )}
        />
      </Box>
      <Box>
        <Controller
          name="settings_max_retries"
          control={control}
          rules={{ min: 0, required: true }}
          render={({ field }) => (
            <TextField
              {...field}
              fullWidth
              label="Max Retries"
              type="number"
              margin="normal"
            />
          )}
        />
      </Box>
      <Box>
        <Controller
          name="settings_timeout_ms"
          control={control}
          rules={{ min: 1000, required: true }}
          render={({ field }) => (
            <TextField
              {...field}
              fullWidth
              label="Timeout (ms)"
              type="number"
              margin="normal"
              inputProps={{
                min: 1000,
                autoComplete: "nope",
                "data-lpignore": "true",
                "data-form-type": "other",
              }}
              autoComplete="nope"
            />
          )}
        />
      </Box>
    </Box>
  );

  const formContent = (
    <Box sx={{ py: 1 }}>
      <style
        dangerouslySetInnerHTML={{
          __html: `
          input:-webkit-autofill,
          input:-webkit-autofill:hover,
          input:-webkit-autofill:focus,
          input:-webkit-autofill:active {
            -webkit-box-shadow: 0 0 0 30px white inset !important;
            transition: background-color 5000s ease-in-out 0s;
          }
          input[readonly] {
            background-color: transparent !important;
          }
        `,
        }}
      />

      {errorMessage && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {errorMessage}
        </Alert>
      )}

      {typeSelect}

      {selectedType && (
        <>
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              gap: 2,
              mb: 2,
              mt: 2,
              p: 2,
              bgcolor: "action.hover",
              borderRadius: 1,
            }}
          >
            <Box
              component="img"
              src={`/api/connectors/${selectedType}/icon.svg`}
              alt={`${selectedType} icon`}
              sx={{ width: 32, height: 32 }}
            />
            <Box>
              <Typography variant="subtitle1" fontWeight="medium">
                {connectorTypes.find(c => c.type === selectedType)?.name ||
                  selectedType}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {connectorTypes.find(c => c.type === selectedType)?.description}
              </Typography>
            </Box>
          </Box>

          {basicInformationSection}
          {connectionConfigSection}
          {advancedSettingsSection}
          <Box
            sx={{ display: "flex", justifyContent: "flex-end", gap: 1, mt: 2 }}
          >
            <Button onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="contained" disableElevation>
              {connector ? "Update" : "Create"}
            </Button>
          </Box>
        </>
      )}
    </Box>
  );

  const lastDirty = useRef<boolean>(false);
  useEffect(() => {
    if (onDirtyChange && lastDirty.current !== isDirty) {
      lastDirty.current = isDirty;
      onDirtyChange(isDirty);
    }
  }, [isDirty, onDirtyChange]);

  return (
    <Box
      component="form"
      autoComplete="nope"
      noValidate
      onSubmit={handleSubmit(onSubmitInternal, onSubmitError)}
      sx={{ p: 2, maxWidth: "800px", mx: "auto" }}
      data-form-type="other"
    >
      {formContent}

      <Snackbar
        open={!!snackbarMessage}
        autoHideDuration={4000}
        onClose={() => setSnackbarMessage(null)}
        message={snackbarMessage}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      />
    </Box>
  );
}

export default ConnectorForm;
