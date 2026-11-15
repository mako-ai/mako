import {
  Button,
  Box,
  Typography,
  Alert,
  CircularProgress,
} from "@mui/material";
import { useConnectorCatalogStore } from "../../store/connectorCatalogStore";
import { connectorIconUrl } from "../../lib/connector-icon";
import { EntityHistoryButton } from "../EntityHistoryButton";
import { WORKSPACE_TYPE_PREFIX } from "./source-connection-schema";
import { TypeSelect } from "./TypeSelect";
import { BasicInformationSection } from "./BasicInformationSection";
import { ConnectionConfigSection } from "./ConnectionConfigSection";
import { AdvancedSettingsSection } from "./AdvancedSettingsSection";
import type { SourceConnectionFormModel } from "./useSourceConnectionForm";

export function SourceConnectionFormContent({
  model,
}: {
  model: SourceConnectionFormModel;
}) {
  const {
    onClose,
    connector,
    connectorTypes,
    errorMessage,
    currentWorkspace,
    isSubmitting,
    testing,
    testResult,
    setTestResult,
    isDirty,
    selectedType,
    readOnly,
    fetchSchema,
    runTest,
  } = model;
  return (
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

      {readOnly && (
        <Alert severity="info" sx={{ mb: 2 }}>
          {currentWorkspace?.role === "viewer"
            ? "Viewers can see source connections but not change them."
            : "Only this connection's managers can change it. The Managers tab shows who they are."}
        </Alert>
      )}

      <TypeSelect model={model} />

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
              src={connectorIconUrl(selectedType, currentWorkspace?.id)}
              alt={`${selectedType} icon`}
              sx={{ width: 32, height: 32 }}
            />
            <Box>
              <Typography
                variant="subtitle1"
                sx={{
                  fontWeight: "medium",
                }}
              >
                {connectorTypes.find(c => c.type === selectedType)?.name ||
                  selectedType}
              </Typography>
              <Typography
                variant="caption"
                sx={{
                  color: "text.secondary",
                }}
              >
                {connectorTypes.find(c => c.type === selectedType)?.description}
              </Typography>
            </Box>
            {selectedType.startsWith(WORKSPACE_TYPE_PREFIX) && (
              <Box sx={{ ml: "auto", flexShrink: 0 }}>
                {/* The definition's folder in the workspace repo, not this
                    connection: connections are credentials, not files. */}
                <EntityHistoryButton
                  entity="connector"
                  id={selectedType.slice(WORKSPACE_TYPE_PREFIX.length)}
                  onRestored={() => {
                    if (currentWorkspace) {
                      void useConnectorCatalogStore
                        .getState()
                        .fetchCatalog(currentWorkspace.id, true);
                    }
                    void fetchSchema(selectedType, true);
                  }}
                />
              </Box>
            )}
          </Box>

          <BasicInformationSection model={model} />
          <ConnectionConfigSection model={model} />
          <AdvancedSettingsSection model={model} />
          {testResult && (
            <Alert
              severity={testResult.success ? "success" : "error"}
              sx={{ mt: 2 }}
              onClose={() => setTestResult(null)}
            >
              {testResult.message ||
                (testResult.success ? "Connected" : "The test failed")}
            </Alert>
          )}
          <Box
            sx={{ display: "flex", justifyContent: "flex-end", gap: 1, mt: 2 }}
          >
            {connector?._id && (
              <Button
                onClick={() => void runTest()}
                disabled={testing || isSubmitting || isDirty}
                sx={{ mr: "auto" }}
                startIcon={
                  testing ? (
                    <CircularProgress size={16} color="inherit" />
                  ) : undefined
                }
              >
                {testing ? "Testing…" : "Test connection"}
              </Button>
            )}
            <Button onClick={onClose} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="contained"
              disableElevation
              disabled={isSubmitting || readOnly}
              startIcon={
                isSubmitting ? (
                  <CircularProgress size={16} color="inherit" />
                ) : undefined
              }
            >
              {isSubmitting
                ? connector
                  ? "Updating…"
                  : "Creating…"
                : connector
                  ? "Update"
                  : "Create"}
            </Button>
          </Box>
        </>
      )}
    </Box>
  );
}
