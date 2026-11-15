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
  IconButton,
} from "@mui/material";
import { Delete as DeleteIcon } from "@mui/icons-material";
import { Controller, UseFormReturn, useFieldArray } from "react-hook-form";
import { type ConnectorFieldSchema } from "./source-connection-schema";

/**
 * One repeatable group of sub-fields (e.g. REST queries). Declared at module
 * scope: defined inside the form it was a new component type on every
 * render, so React remounted it — and its inputs — each time.
 */
export function ObjectArrayField({
  field,
  form,
  readOnly,
}: {
  field: ConnectorFieldSchema;
  form: UseFormReturn<any>;
  readOnly: boolean;
}) {
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
      <Typography
        variant="subtitle1"
        sx={{
          fontWeight: "medium",
          mb: 1,
        }}
      >
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
              aria-label="Remove"
              size="small"
              color="error"
              disabled={readOnly}
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
              disabled: readOnly,
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
                      <Select
                        {...field}
                        label={subField.label}
                        disabled={readOnly}
                      >
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
                      disabled={readOnly}
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
        disabled={readOnly}
        onClick={() => append(createNewItem())}
      >
        Add Query
      </Button>
    </Box>
  );
}
