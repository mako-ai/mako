import { useWorkspace } from "../../contexts/workspace-context";
import { useEffect, useState, useMemo, useRef } from "react";
import { useForm } from "react-hook-form";
import { useSourceConnectionStore } from "../../store/sourceConnectionStore";
import { useConnectorCatalogStore } from "../../store/connectorCatalogStore";
import { notify } from "../../store/notificationStore";
import { useSourceConnectionEntitiesStore } from "../../store/sourceConnectionEntitiesStore";
import {
  generateDefaultValues,
  type ConnectorFieldSchema,
  type ConnectorSchemaResponse,
  type SourceConnectionFormProps,
} from "./source-connection-schema";

/** Form notices: a plain bottom-center message. */
function notifyFormNotice(message: string) {
  notify.message(message, {
    anchorOrigin: { vertical: "bottom", horizontal: "center" },
  });
}

/** Save confirmation: a filled bottom-right success toast. */
function notifySaved(message: string) {
  notify.success(message, {
    anchorOrigin: { vertical: "bottom", horizontal: "right" },
    variant: "filled",
  });
}

/** State, schema loading, secret reveal, test and save for the source connection form. */
export function useSourceConnectionForm({
  onClose,
  onSubmit,
  connector,
  connectorTypes = [],
  errorMessage,
  tabId,
  onDirtyChange,
}: SourceConnectionFormProps) {
  const { currentWorkspace } = useWorkspace();
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
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);
  const [tab, setTab] = useState<"connection" | "managers" | "access">(
    "connection",
  );

  const draftRef = useRef<Record<string, any> | undefined>(
    tabId
      ? useSourceConnectionStore.getState().drafts[tabId]?.values
      : undefined,
  );
  useEffect(() => {
    if (tabId) {
      draftRef.current =
        useSourceConnectionStore.getState().drafts[tabId]?.values;
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
  // The server refuses a change by someone who may not make it; say so first.
  const readOnly = connector
    ? connector.canEdit === false
    : currentWorkspace?.role === "viewer";

  useEffect(() => {
    if (connector) {
      const mutableDefaults = JSON.parse(JSON.stringify(defaultValues));
      reset(mutableDefaults);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connector?._id]);

  const schemas = useConnectorCatalogStore(s => s.schemas);
  const fetchSchema = useConnectorCatalogStore(s => s.fetchSchema);

  useEffect(() => {
    if (!selectedType) {
      setSchema(null);
      return;
    }
    if (schemas[selectedType]) {
      setSchema(schemas[selectedType]);
      // A second fetch that raced the first answered null; the schema is here.
      setSchemaError(null);
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

  // Reveal a stored secret: the SERVER reads the ciphertext from its own
  // connector record (apps.md — connector decrypt oracle fix). The client
  // names a field; it never sends ciphertext, and it no longer picks the
  // workspace id. Admin/owner only, server-enforced.
  const revealSecret = async (fieldName: string) => {
    const connectorId = connector?._id;
    if (!connectorId) {
      notifyFormNotice(
        "Save the source connection before revealing its secrets",
      );
      return;
    }
    if (!currentWorkspace?.id) return;

    setDecryptingFields(prev => ({ ...prev, [fieldName]: true }));

    try {
      const response = await fetch(
        `/api/workspaces/${currentWorkspace.id}/connections/sources/${connectorId}/reveal-secret`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ field: fieldName }),
        },
      );

      const result = await response.json();

      if (result.success) {
        setDecryptedValues(prev => ({
          ...prev,
          [fieldName]: result.data.value,
        }));
        setShowDecryptedFields(prev => ({ ...prev, [fieldName]: true }));
        if (!result.data.wasEncrypted) {
          notifyFormNotice("Value was not encrypted");
        }
      } else {
        notifyFormNotice(result.error || "Failed to reveal value");
      }
    } catch {
      notifyFormNotice("Failed to reveal value");
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

  const getDisplayValue = (fieldName: string, fieldValue: unknown): unknown => {
    if (!showDecryptedFields[fieldName] || !decryptedValues[fieldName]) {
      return fieldValue;
    }

    const persistedEncryptedValue =
      connector?.config &&
      typeof connector.config === "object" &&
      connector.config !== null
        ? (connector.config as Record<string, unknown>)[fieldName]
        : undefined;

    // Show decrypted text only while value is still the persisted encrypted blob.
    // Once user edits, keep showing the live RHF value so the field remains editable.
    if (fieldValue !== persistedEncryptedValue) {
      return fieldValue;
    }

    return decryptedValues[fieldName];
  };

  const onSubmitInternal = async (values: Record<string, unknown>) => {
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
            (f.itemFields ?? []).forEach(sub => {
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
        notifyFormNotice(
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
      notifyFormNotice("No changes to save");
      return;
    }

    // submitting payload
    setIsSubmitting(true);
    try {
      const result = await onSubmit(payload);
      // A `void` return is treated as success (legacy callers); only an explicit
      // `{ success: false }` suppresses the success toast.
      const succeeded = !result || result.success !== false;
      if (succeeded) {
        notifySaved(
          isNewConnector
            ? "Source connection created successfully"
            : "Source connection updated successfully",
        );
      }
    } catch (err) {
      console.error("[SourceConnectionForm] onSubmit threw", err);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Test the saved connection: the server uses the stored credential.
  const runTest = async () => {
    if (!currentWorkspace || !connector?._id) return;
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(
        await useSourceConnectionEntitiesStore
          .getState()
          .test(currentWorkspace.id, connector._id),
      );
    } finally {
      setTesting(false);
    }
  };

  const onSubmitError = (errors: Record<string, any>) => {
    console.error("[SourceConnectionForm] validation errors", errors);
  };

  const lastDirty = useRef<boolean>(false);
  useEffect(() => {
    if (onDirtyChange && lastDirty.current !== isDirty) {
      lastDirty.current = isDirty;
      onDirtyChange(isDirty);
    }
  }, [isDirty, onDirtyChange]);

  return {
    onClose,
    onSubmit,
    connector,
    connectorTypes,
    errorMessage,
    tabId,
    onDirtyChange,
    currentWorkspace,
    schema,
    setSchema,
    schemaLoading,
    setSchemaLoading,
    schemaError,
    setSchemaError,
    decryptedValues,
    setDecryptedValues,
    decryptingFields,
    setDecryptingFields,
    showDecryptedFields,
    setShowDecryptedFields,
    isSubmitting,
    setIsSubmitting,
    testing,
    setTesting,
    testResult,
    setTestResult,
    tab,
    setTab,
    draftRef,
    defaultValues,
    form,
    control,
    handleSubmit,
    watch,
    reset,
    errors,
    isDirty,
    selectedType,
    readOnly,
    schemas,
    fetchSchema,
    revealSecret,
    toggleDecryptedVisibility,
    getDisplayValue,
    onSubmitInternal,
    runTest,
    onSubmitError,
    lastDirty,
  };
}

export type SourceConnectionFormModel = ReturnType<
  typeof useSourceConnectionForm
>;
