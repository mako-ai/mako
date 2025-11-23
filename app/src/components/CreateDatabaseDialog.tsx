import React, { useEffect, useState } from "react";
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
} from "@mui/material";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import { useWorkspace } from "../contexts/workspace-context";
import { apiClient } from "../lib/api-client";
import { useDatabaseCatalogStore } from "../store/databaseCatalogStore";
import { useForm, Controller } from "react-hook-form";

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

  // Reset or fetch data when dialog opens
  useEffect(() => {
    if (!open) return;

    if (databaseId && currentWorkspace) {
      // Edit mode: fetch existing database
      setLoading(true);
      setStep("configure"); // Skip type selection

      apiClient
        .get<{ success: boolean; data: any }>(
          `/workspaces/${currentWorkspace.id}/databases/${databaseId}`,
        )
        .then(async res => {
          if (res.success && res.data) {
            const db = res.data;
            // Ensure schema is loaded
            if (!schemas[db.type]) {
              await fetchSchema(db.type);
            }

            reset({
              name: db.name,
              type: db.type,
              connection: db.connection || {},
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
  }, [open, databaseId, currentWorkspace, reset, fetchSchema, schemas]);

  const handleClose = () => {
    reset({ name: "", type: "", connection: {} });
    setError(null);
    setStep("select");
    onClose();
  };

  const onSubmit = async (values: FormValues) => {
    if (!currentWorkspace) {
      setError("No workspace selected");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      let res;
      if (databaseId) {
        // Update existing database
        res = await apiClient.put<{
          success: boolean;
          data: any;
          message?: string;
        }>(
          `/workspaces/${currentWorkspace.id}/databases/${databaseId}`,
          values,
        );
      } else {
        // Create new database
        res = await apiClient.post<{
          success: boolean;
          data: any;
          message?: string;
        }>(`/workspaces/${currentWorkspace.id}/databases`, values);
      }

      if (!res.success) {
        throw new Error((res as any).error || "Failed to save database");
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
    const schema = schemas[newType] || (await fetchSchema(newType));
    const defaults: Record<string, any> = {};
    if (schema?.fields) {
      schema.fields.forEach(f => {
        if (f.default !== undefined) defaults[f.name] = f.default;
        else if (f.type === "boolean") defaults[f.name] = false;
        else defaults[f.name] = "";
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
            <Box sx={{ pt: 1 }}>
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
                schemas[selectedType]?.fields && (
                  <>
                    {schemas[selectedType].fields.map(field => {
                      const fieldName = `connection.${field.name}` as const;
                      // For password fields in edit mode, make them optional if they are empty (meaning unchanged)
                      // BUT, the user sees the value if we pre-fill it.
                      // If we pre-fill, the value is there, so "required" check passes.

                      const requiredRule = field.required
                        ? { required: `${field.label} is required` }
                        : {};

                      const fieldError =
                        ((errors.connection as any)?.[field.name]
                          ?.message as string) || undefined;
                      switch (field.type) {
                        case "boolean":
                          return (
                            <FormControl
                              key={field.name}
                              fullWidth
                              margin="normal"
                            >
                              <Box
                                sx={{ display: "flex", alignItems: "center" }}
                              >
                                <Typography sx={{ mr: 2 }}>
                                  {field.label}
                                </Typography>
                                <Controller
                                  control={control}
                                  name={fieldName as any}
                                  rules={requiredRule}
                                  render={({
                                    field: ctrlField,
                                    fieldState,
                                  }) => (
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
                              {...register(fieldName as any, requiredRule)}
                              error={Boolean(fieldError)}
                              helperText={fieldError ?? field.helperText}
                            />
                          );
                        case "password":
                          return (
                            <TextField
                              key={field.name}
                              fullWidth
                              type="password"
                              label={field.label}
                              margin="normal"
                              placeholder={field.placeholder}
                              {...register(fieldName as any, requiredRule)}
                              error={Boolean(fieldError)}
                              helperText={fieldError ?? field.helperText}
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
                              {...register(fieldName as any, {
                                ...requiredRule,
                                valueAsNumber: true,
                              })}
                              error={Boolean(fieldError)}
                              helperText={fieldError ?? field.helperText}
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
                                name={fieldName as any}
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
                                      <MenuItem
                                        key={opt.value}
                                        value={opt.value}
                                      >
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
                              {...register(fieldName as any, requiredRule)}
                              error={Boolean(fieldError)}
                              helperText={fieldError ?? field.helperText}
                            />
                          );
                      }
                    })}
                  </>
                )
              )}
            </Box>
          </DialogContent>
          <DialogActions>
            <Button onClick={handleClose} disabled={loading}>
              Cancel
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
          </DialogActions>
        </>
      )}
    </Dialog>
  );
};

export default CreateDatabaseDialog;
