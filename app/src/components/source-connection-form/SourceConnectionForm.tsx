import { Box, Tab, Tabs } from "@mui/material";
import ConnectionManagersPanel from "../ConnectionManagersPanel";
import ConnectionWritersPanel from "../ConnectionWritersPanel";
import type { SourceConnectionFormProps } from "./source-connection-schema";
import { useSourceConnectionForm } from "./useSourceConnectionForm";
import { SourceConnectionFormContent } from "./SourceConnectionFormContent";

function SourceConnectionForm(props: SourceConnectionFormProps) {
  const model = useSourceConnectionForm(props);
  const {
    connector,
    tab,
    setTab,
    handleSubmit,
    onSubmitInternal,
    onSubmitError,
  } = model;
  return (
    <Box
      component="form"
      autoComplete="nope"
      noValidate
      onSubmit={handleSubmit(onSubmitInternal, onSubmitError)}
      sx={{ p: 2, maxWidth: "800px", mx: "auto" }}
      data-form-type="other"
    >
      {connector?._id && (
        <Tabs
          value={tab}
          onChange={(_, value) => setTab(value)}
          sx={{
            minHeight: 40,
            borderBottom: 1,
            borderColor: "divider",
            "& .MuiTab-root": { minHeight: 40, textTransform: "none" },
          }}
        >
          <Tab value="connection" label="Connection" />
          <Tab value="managers" label="Managers" />
          <Tab value="access" label="Access" />
        </Tabs>
      )}
      {tab === "managers" && connector?._id ? (
        <Box sx={{ py: 2 }}>
          <ConnectionManagersPanel connectionId={connector._id} />
        </Box>
      ) : tab === "access" && connector?._id ? (
        <Box sx={{ py: 2 }}>
          <ConnectionWritersPanel
            // Reload when the caller's edit rights change (a manager removed
            // themself), so the writers controls match the managers list.
            key={String(connector.canEdit)}
            kind="source"
            connectionId={connector._id}
            connectionName={connector.name || "this connection"}
          />
        </Box>
      ) : (
        <SourceConnectionFormContent model={model} />
      )}
    </Box>
  );
}

export default SourceConnectionForm;
