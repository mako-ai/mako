import React, { useEffect, useState, useCallback, useRef } from "react";
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  TextField,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Box,
  Alert,
  CircularProgress,
  Typography,
  Card,
  CardActionArea,
  Avatar,
  IconButton,
  InputAdornment,
} from "@mui/material";
import Accordion from "@mui/material/Accordion";
import AccordionSummary from "@mui/material/AccordionSummary";
import AccordionDetails from "@mui/material/AccordionDetails";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import Visibility from "@mui/icons-material/Visibility";
import VisibilityOff from "@mui/icons-material/VisibilityOff";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import ErrorIcon from "@mui/icons-material/Error";
import { useWorkspace } from "../contexts/workspace-context";
import { useDatabaseCatalogStore } from "../store/databaseCatalogStore";
import { useSchemaStore } from "../store/schemaStore";
import { useForm, Controller } from "react-hook-form";
import { trackEvent } from "../lib/analytics";
import {
  parsePostgresConnectionString,
  buildPostgresConnectionString,
} from "../utils/postgres-connection-string";
import {
  parseMySQLConnectionString,
  buildMySQLConnectionString,
} from "../utils/mysql-connection-string";

/** Set a value at a dot-separated path inside a nested object, creating intermediate objects as needed. */
function setNested(obj: Record<string, any>, path: string, value: any) {
  const keys = path.split(".");
  let curr = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!curr[keys[i]] || typeof curr[keys[i]] !== "object") curr[keys[i]] = {};
    curr = curr[keys[i]];
  }
  curr[keys[keys.length - 1]] = value;
}

/** Resolve a dot-separated path on a potentially nested object. */
function getNested(obj: Record<string, any> | undefined, path: string): any {
  if (!obj) return undefined;
  return path.split(".").reduce((acc: any, key) => acc?.[key], obj);
}

interface CreateDatabaseDialogProps {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
  databaseId?: string;
}

const CreateDatabaseDialog: React.FC<CreateDatabaseDialogProps> = ({
  open,
  onClose,
  onSuccess,
  databaseId,
}) => {
  const { currentWorkspace } = useWorkspace();
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [step, setStep] = useState<"select" | "configure">("select");

  // Password visibility state (keyed by field name)
  const [showPassword, setShowPassword] = useState<Record<string, boolean>>({});

  // Test connection state
  const [testingConnection, setTestingConnection] = useState(false);
  const [testResult, setTestResult] = useState<{
    success: boolean;
    error?: string;
  } | null>(null);

  // Ref to prevent infinite loops in two-way binding
  const isUpdatingFromConnectionString = useRef(false);
  const isUpdatingFromFields = useRef(false);

  type FormValues = {
    name: string;
    type: string;
    connection: Record<string, any>;
  };

  const {
    register,
    control,
    handleSubmit,
    reset,
    setValue,
    watch,
    formState: { errors },
  } = useForm<FormValues>({
    defaultValues: { name: "", type: "", connection: {} },
    mode: "onSubmit",
    reValidateMode: "onChange",
  });

  const {
    fetchTypes,
    fetchSchema,
    types: dbTypes,
    schemas,
  } = useDatabaseCatalogStore();
  const { testConnection, fetchDatabase, saveDatabase } = useSchemaStore();

  // Toggle password visibility for a field
  const togglePasswordVisibility = useCallback((fieldName: string) => {
    setShowPassword(prev => ({ ...prev, [fieldName]: !prev[fieldName] }));
  }, []);

  // Test connection without saving
  const handleTestConnection = useCallback(async () => {
    if (!currentWorkspace) return;

    const values = watch();
    if (!values.type) {
      setTestResult({ success: false, error: "Database type is required" });
      return;
    }

    setTestingConnection(true);
    setTestResult(null);

    try {
      const res = await testConnection(currentWorkspace.id, {
        type: values.type,
        connection: values.connection,
      });
      setTestResult(res);
    } catch (err) {
      setTestResult({
        success: false,
        error: err instanceof Error ? err.message : "Connection test failed",
      });
    } finally {
      setTestingConnection(false);
    }
  }, [currentWorkspace, watch, testConnection]);

  // Watch PostgreSQL fields for two-way binding
  const watchedConnection = watch("connection");
  const watchedType = watch("type");

  const supportsConnectionStringType =
    watchedType === "postgresql" ||
    watchedType === "redshift" ||
    watchedType === "mysql";

  // Two-way binding: Connection string -> Individual fields (PostgreSQL/MySQL)
  useEffect(() => {
    if (!supportsConnectionStringType) return;
    if (isUpdatingFromFields.current) return;
    if (!watchedConnection?.connectionString) return;

    const parsed =
      watchedType === "postgresql" || watchedType === "redshift"
        ? parsePostgresConnectionString(watchedConnection.connectionString)
        : parseMySQLConnectionString(watchedConnection.connectionString);
    if (!parsed) return;

    isUpdatingFromConnectionString.current = true;

    // Update individual fields from parsed connection string
    if (parsed.host !== undefined && parsed.host !== watchedConnection.host) {
      setValue("connection.host", parsed.host);
    }
    if (parsed.port !== undefined && parsed.port !== watchedConnection.port) {
      setValue("connection.port", parsed.port);
    }
    if (
      parsed.database !== undefined &&
      parsed.database !== watchedConnection.database
    ) {
      setValue("connection.database", parsed.database);
    }
    if (
      parsed.username !== undefined &&
      parsed.username !== watchedConnection.username
    ) {
      setValue("connection.username", parsed.username);
    }
    if (
      parsed.password !== undefined &&
      parsed.password !== watchedConnection.password
    ) {
      setValue("connection.password", parsed.password);
    }
    if (parsed.ssl !== undefined && parsed.ssl !== watchedConnection.ssl) {
      setValue("connection.ssl", parsed.ssl);
    }

    // Reset flag after a tick to allow re-triggering
    setTimeout(() => {
      isUpdatingFromConnectionString.current = false;
    }, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    supportsConnectionStringType,
    watchedType,
    watchedConnection?.connectionString,
    setValue,
  ]);

  // Two-way binding: Individual fields -> Connection string (PostgreSQL/MySQL)
  useEffect(() => {
    if (!supportsConnectionStringType) return;
    if (isUpdatingFromConnectionString.current) return;
    if (!watchedConnection?.use_connection_string) return;

    // Only build if we have at least a host
    if (!watchedConnection.host) return;

    isUpdatingFromFields.current = true;

    const builtString =
      watchedType === "postgresql" || watchedType === "redshift"
        ? buildPostgresConnectionString({
            host: watchedConnection.host,
            port: watchedConnection.port,
            database: watchedConnection.database,
            username: watchedConnection.username,
            password: watchedConnection.password,
            ssl: watchedConnection.ssl,
          })
        : buildMySQLConnectionString({
            host: watchedConnection.host,
            port: watchedConnection.port,
            database: watchedConnection.database,
            username: watchedConnection.username,
            password: watchedConnection.password,
            ssl: watchedConnection.ssl,
          });

    if (builtString && builtString !== watchedConnection.connectionString) {
      setValue("connection.connectionString", builtString);
    }

    setTimeout(() => {
      isUpdatingFromFields.current = false;
    }, 0);
  }, [
    supportsConnectionStringType,
    watchedType,
    watchedConnection?.use_connection_string,
    watchedConnection?.host,
    watchedConnection?.port,
    watchedConnection?.database,
    watchedConnection?.username,
    watchedConnection?.password,
    watchedConnection?.ssl,
    watchedConnection?.connectionString,
    setValue,
  ]);

  // Reset or fetch data when dialog opens
  useEffect(() => {
    if (!open) return;

    if (databaseId && currentWorkspace) {
      // Edit mode: fetch existing database
      setLoading(true);
      setStep("configure"); // Skip type selection

      fetchDatabase(currentWorkspace.id, databaseId)
        .then(async db => {
          if (db) {
            const typedDb = db as {
              name: string;
              type: string;
              connection?: Record<string, unknown>;
            };
            // Ensure schema is loaded
            if (!schemas[typedDb.type]) {
              await fetchSchema(typedDb.type);
            }

            reset({
              name: typedDb.name,
              type: typedDb.type,
              connection: typedDb.connection || {},
            });
          }
        })
        .catch(err => {
          console.error("Failed to fetch database details:", err);
          setError("Failed to load database details");
        })
        .finally(() => {
          setLoading(false);
        });
    } else {
      // Create mode: reset form
      reset({ name: "", type: "", connection: {} });
      setStep("select");
      setError(null);
    }
  }, [
    open,
    databaseId,
    currentWorkspace,
    reset,
    fetchSchema,
    schemas,
    fetchDatabase,
  ]);

  const handleClose = () => {
    reset({ name: "", type: "", connection: {} });
    setError(null);
    setStep("select");
    setShowPassword({});
    setTestResult(null);
    onClose();
  };

  const onSubmit = async (values: FormValues) => {
    if (!currentWorkspace) {
      setError("No workspace selected");
      return;
    }
    setLoading(true);
    setError(null);
    setTestResult(null);
    try {
      const res = await saveDatabase(currentWorkspace.id, values, databaseId);

      if (!res.success) {
        throw new Error(res.error || "Failed to save database");
      }

      // Track database connection creation (not updates)
      if (!databaseId) {
        const savedData = res.data as { _id?: string } | undefined;
        trackEvent("database_connection_created", {
          connection_type: values.type,
          connection_id: savedData?._id,
        });
      }

      onSuccess();
      handleClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error occurred");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) {
      fetchTypes(true).catch(() => undefined);
    }
  }, [fetchTypes, open]);

  const selectedType = watch("type");

  const handleTypeChange = async (newType: string) => {
    setValue("type", newType, { shouldValidate: true, shouldDirty: true });
    // Always fetch schema if not cached or if cached schema has no fields (failed previous request)
    const cachedSchema = schemas[newType];
    const schema =
      cachedSchema?.fields?.length > 0
        ? cachedSchema
        : await fetchSchema(newType, true);
    const defaults: Record<string, any> = {};
    if (schema?.fields) {
      schema.fields.forEach(f => {
        const val =
          f.default !== undefined
            ? f.default
            : f.type === "boolean"
              ? false
              : "";
        setNested(defaults, f.name, val);
      });
    }
    reset(prev => ({ ...prev, type: newType, connection: defaults }));
    setStep("configure");
  };

  const handleBack = () => {
    // If editing, back shouldn't go to type selection (usually)
    // But if we want to allow changing type (which is weird for editing), we could.
    // Typically changing type of an existing database is not supported easily.
    // So we might want to hide the back button in edit mode.
    if (databaseId) {
      handleClose(); // Or just close?
      return;
    }
    setStep("select");
    setError(null);
  };

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
      {step === "select" ? (
        <>
          <DialogTitle>Select Database Type</DialogTitle>
          <DialogContent>
            <Box sx={{ pt: 1 }}>
              <Box
                sx={{
                  display: "grid",
                  gridTemplateColumns: {
                    xs: "repeat(2, 1fr)",
                    sm: "repeat(3, 1fr)",
                  },
                  gap: 2,
                }}
              >
                {(dbTypes || []).map(t => (
                  <Card
                    key={t.type}
                    variant="outlined"
                    sx={{
                      height: "100%",
                      "&:hover": { borderColor: "primary.main" },
                    }}
                  >
                    <CardActionArea
                      onClick={() => handleTypeChange(t.type)}
                      sx={{ height: "100%", p: 2 }}
                    >
                      <Box
                        sx={{
                          display: "flex",
                          flexDirection: "column",
                          alignItems: "center",
                          gap: 1,
                        }}
                      >
                        <Avatar
                          src={t.iconUrl}
                          alt={t.displayName}
                          sx={{
                            width: 40,
                            height: 40,
                            "& .MuiAvatar-img": {
                              objectFit: "contain",
                            },
                          }}
                          variant="square"
                        >
                          {t.displayName?.[0]}
                        </Avatar>
                        <Typography
                          variant="body2"
                          align="center"
                          fontWeight="medium"
                        >
                          {t.displayName || t.type}
                        </Typography>
                      </Box>
                    </CardActionArea>
                  </Card>
                ))}
              </Box>
            </Box>
          </DialogContent>
          <DialogActions>
            <Button onClick={handleClose}>Cancel</Button>
          </DialogActions>
        </>
      ) : (
        <>
          <DialogTitle sx={{ display: "flex", alignItems: "center", gap: 1 }}>
            {!databaseId && (
              <IconButton onClick={handleBack} size="small" edge="start">
                <ArrowBackIcon />
              </IconButton>
            )}
            {databaseId ? "Edit Database" : "Configure Database"}
          </DialogTitle>
          <DialogContent>
            <Box
              component="form"
              autoComplete="off"
              data-form-type="other"
              data-lpignore="true"
              data-1p-ignore
              sx={{ pt: 1 }}
              onSubmit={e => e.preventDefault()}
            >
              {error && (
                <Alert severity="error" sx={{ mb: 2 }}>
                  {error}
                </Alert>
              )}

              <TextField
                fullWidth
                label="Database Name"
                {...register("name", { required: "Name is required" })}
                margin="normal"
                required
                placeholder="My Database"
                error={Boolean(errors.name)}
                helperText={errors.name?.message as string}
                autoComplete="off"
              />

              {/* Hidden input to register 'type' as required for validation */}
              <input
                type="hidden"
                {...register("type", { required: "Database type is required" })}
              />

              {/* Dynamic schema-driven form */}
              {loading ? (
                <Box sx={{ display: "flex", justifyContent: "center", p: 4 }}>
                  <CircularProgress />
                </Box>
              ) : (
                selectedType &&
                schemas[selectedType]?.fields &&
                (() => {
                  const allFields = schemas[selectedType].fields;
                  const primaryFields = allFields.filter(f => !f.advanced);
                  const advancedFields = allFields.filter(f => f.advanced);

                  const advancedGroups = advancedFields.reduce<
                    Record<string, typeof advancedFields>
                  >((acc, f) => {
                    const g = f.group || "Advanced";
                    (acc[g] ||= []).push(f);
                    return acc;
                  }, {});

                  const isFieldVisible = (
                    field: (typeof allFields)[number],
                  ) => {
                    if (!field.visibleWhen) return true;
                    const val = getNested(
                      watchedConnection,
                      field.visibleWhen.field,
                    );
                    return val === field.visibleWhen.equals;
                  };

                  const renderField = (field: (typeof allFields)[number]) => {
                    if (!isFieldVisible(field)) return null;

                    const fieldName =
                      `connection.${field.name}` as `connection.${string}`;
                    const requiredRule = field.required
                      ? { required: `${field.label} is required` }
                      : {};
                    const fieldError =
                      (getNested(errors, fieldName)?.message as string) ||
                      undefined;

                    switch (field.type) {
                      case "boolean":
                        return (
                          <FormControl
                            key={field.name}
                            fullWidth
                            margin="normal"
                          >
                            <Box
                              sx={{
                                display: "flex",
                                alignItems: "center",
                              }}
                            >
                              <Typography sx={{ mr: 2 }}>
                                {field.label}
                              </Typography>
                              <Controller
                                control={control}
                                name={fieldName}
                                rules={requiredRule}
                                render={({ field: ctrlField, fieldState }) => (
                                  <input
                                    type="checkbox"
                                    checked={Boolean(ctrlField.value)}
                                    onChange={e =>
                                      ctrlField.onChange(e.target.checked)
                                    }
                                    aria-invalid={
                                      fieldState.error ? "true" : "false"
                                    }
                                  />
                                )}
                              />
                            </Box>
                            {fieldError ? (
                              <Typography variant="caption" color="error">
                                {fieldError}
                              </Typography>
                            ) : (
                              field.helperText && (
                                <Typography
                                  variant="caption"
                                  color="text.secondary"
                                >
                                  {field.helperText}
                                </Typography>
                              )
                            )}
                          </FormControl>
                        );
                      case "textarea":
                        return (
                          <TextField
                            key={field.name}
                            fullWidth
                            label={field.label}
                            margin="normal"
                            placeholder={field.placeholder}
                            multiline
                            rows={field.rows || 3}
                            {...register(fieldName, requiredRule)}
                            error={Boolean(fieldError)}
                            helperText={fieldError ?? field.helperText}
                            autoComplete="off"
                          />
                        );
                      case "password":
                        return (
                          <TextField
                            key={field.name}
                            fullWidth
                            type={
                              showPassword[field.name] ? "text" : "password"
                            }
                            label={field.label}
                            margin="normal"
                            placeholder={field.placeholder}
                            {...register(fieldName, requiredRule)}
                            error={Boolean(fieldError)}
                            helperText={fieldError ?? field.helperText}
                            autoComplete="off"
                            slotProps={{
                              input: {
                                endAdornment: (
                                  <InputAdornment position="end">
                                    <IconButton
                                      aria-label={
                                        showPassword[field.name]
                                          ? "Hide password"
                                          : "Show password"
                                      }
                                      onClick={() =>
                                        togglePasswordVisibility(field.name)
                                      }
                                      edge="end"
                                      size="small"
                                    >
                                      {showPassword[field.name] ? (
                                        <VisibilityOff fontSize="small" />
                                      ) : (
                                        <Visibility fontSize="small" />
                                      )}
                                    </IconButton>
                                  </InputAdornment>
                                ),
                              },
                              htmlInput: {
                                "data-1p-ignore": true,
                                "data-lpignore": "true",
                                "data-form-type": "other",
                              },
                            }}
                          />
                        );
                      case "number":
                        return (
                          <TextField
                            key={field.name}
                            fullWidth
                            type="number"
                            label={field.label}
                            margin="normal"
                            placeholder={field.placeholder}
                            {...register(fieldName, {
                              ...requiredRule,
                              valueAsNumber: true,
                            })}
                            error={Boolean(fieldError)}
                            helperText={fieldError ?? field.helperText}
                            autoComplete="off"
                          />
                        );
                      case "select":
                        return (
                          <FormControl
                            key={field.name}
                            fullWidth
                            margin="normal"
                            required={field.required}
                            error={Boolean(fieldError)}
                          >
                            <InputLabel>{field.label}</InputLabel>
                            <Controller
                              control={control}
                              name={fieldName}
                              rules={requiredRule}
                              render={({ field: ctrlField }) => (
                                <Select
                                  label={field.label}
                                  value={ctrlField.value ?? ""}
                                  onChange={e =>
                                    ctrlField.onChange(String(e.target.value))
                                  }
                                >
                                  {(field.options || []).map(opt => (
                                    <MenuItem key={opt.value} value={opt.value}>
                                      {opt.label}
                                    </MenuItem>
                                  ))}
                                </Select>
                              )}
                            />
                            {fieldError ? (
                              <Typography variant="caption" color="error">
                                {fieldError}
                              </Typography>
                            ) : (
                              field.helperText && (
                                <Typography
                                  variant="caption"
                                  color="text.secondary"
                                >
                                  {field.helperText}
                                </Typography>
                              )
                            )}
                          </FormControl>
                        );
                      case "string":
                      default:
                        return (
                          <TextField
                            key={field.name}
                            fullWidth
                            label={field.label}
                            margin="normal"
                            placeholder={field.placeholder}
                            {...register(fieldName, requiredRule)}
                            error={Boolean(fieldError)}
                            helperText={fieldError ?? field.helperText}
                            autoComplete="off"
                            slotProps={
                              field.name === "username"
                                ? {
                                    htmlInput: {
                                      "data-1p-ignore": true,
                                      "data-lpignore": "true",
                                      "data-form-type": "other",
                                    },
                                  }
                                : undefined
                            }
                          />
                        );
                    }
                  };

                  return (
                    <>
                      {primaryFields.map(renderField)}
                      {Object.entries(advancedGroups).map(([group, fields]) => (
                        <Accordion
                          key={group}
                          disableGutters
                          elevation={0}
                          sx={{
                            mt: 2,
                            border: 1,
                            borderColor: "divider",
                            borderRadius: 1,
                            "&::before": { display: "none" },
                          }}
                        >
                          <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                            <Typography variant="subtitle2">{group}</Typography>
                          </AccordionSummary>
                          <AccordionDetails sx={{ pt: 0 }}>
                            {fields.map(renderField)}
                          </AccordionDetails>
                        </Accordion>
                      ))}
                    </>
                  );
                })()
              )}
            </Box>
          </DialogContent>
          <DialogActions
            sx={{
              flexDirection: "column",
              alignItems: "stretch",
              gap: 1,
              px: 3,
              pb: 2,
            }}
          >
            {/* Test connection result */}
            {testResult && (
              <Alert
                severity={testResult.success ? "success" : "error"}
                icon={
                  testResult.success ? (
                    <CheckCircleIcon fontSize="inherit" />
                  ) : (
                    <ErrorIcon fontSize="inherit" />
                  )
                }
                sx={{ width: "100%" }}
              >
                {testResult.success
                  ? "Connection successful!"
                  : testResult.error || "Connection failed"}
              </Alert>
            )}

            {/* Action buttons */}
            <Box
              sx={{
                display: "flex",
                justifyContent: "flex-end",
                gap: 1,
                width: "100%",
              }}
            >
              <Button onClick={handleClose} disabled={loading}>
                Cancel
              </Button>
              <Button
                onClick={handleTestConnection}
                disabled={loading || testingConnection}
                variant="outlined"
                startIcon={
                  testingConnection ? <CircularProgress size={16} /> : null
                }
              >
                {testingConnection ? "Testing..." : "Test Connection"}
              </Button>
              <Button
                onClick={handleSubmit(onSubmit)}
                variant="contained"
                disabled={loading}
                startIcon={loading ? <CircularProgress size={16} /> : null}
              >
                {loading
                  ? "Saving..."
                  : databaseId
                    ? "Update Database"
                    : "Create Database"}
              </Button>
            </Box>
          </DialogActions>
        </>
      )}
    </Dialog>
  );
};

export default CreateDatabaseDialog;
