import React, { useState, useEffect, useCallback } from "react";
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  TextField,
  Box,
  Typography,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  IconButton,
  Alert,
} from "@mui/material";
import { Close as CloseIcon } from "@mui/icons-material";
import Editor from "@monaco-editor/react";
import { useTheme } from "../contexts/ThemeContext";
import { useWorkspace } from "../contexts/workspace-context";
import { useSchemaStore } from "../store/schemaStore";

interface CreateViewDialogProps {
  open: boolean;
  onClose: () => void;
  onCreateView: (viewDefinition: any) => void;
  isCreating: boolean;
  databaseId?: string;
  workspaceId?: string;
}

const CreateViewDialog: React.FC<CreateViewDialogProps> = ({
  open,
  onClose,
  onCreateView,
  isCreating,
  databaseId,
  workspaceId,
}) => {
  const { effectiveMode } = useTheme();
  const { currentWorkspace } = useWorkspace();
  const fetchDatabaseCollections = useSchemaStore(s => s.fetchCollections);
  const effectiveWorkspaceId = workspaceId || currentWorkspace?.id;
  const [viewName, setViewName] = useState("");
  const [viewOn, setViewOn] = useState("");
  const [collections, setCollections] = useState<string[]>([]);
  const [pipeline, setPipeline] = useState(
    '[\n  {\n    "$match": {\n      // Add your match criteria here\n    }\n  }\n]',
  );
  const [error, setError] = useState<string | null>(null);

  const fetchCollections = useCallback(async () => {
    if (!effectiveWorkspaceId || !databaseId) {
      setCollections([]);
      return;
    }

    try {
      const data = await fetchDatabaseCollections(
        effectiveWorkspaceId,
        databaseId,
      );
      setCollections(data.map(col => col.name));
    } catch (err) {
      console.error("Failed to fetch collections:", err);
    }
  }, [databaseId, effectiveWorkspaceId, fetchDatabaseCollections]);

  useEffect(() => {
    if (open) {
      fetchCollections();
      // Reset form when dialog opens
      setViewName("");
      setViewOn("");
      setPipeline(
        '[\n  {\n    "$match": {\n      // Add your match criteria here\n    }\n  }\n]',
      );
      setError(null);
    }
  }, [fetchCollections, open]);

  const validatePipeline = (pipelineStr: string): any[] | null => {
    try {
      const parsed = JSON.parse(pipelineStr);
      if (!Array.isArray(parsed)) {
        throw new Error("Pipeline must be an array");
      }
      return parsed;
    } catch (error) {
      return null;
    }
  };

  const handleCreate = () => {
    setError(null);

    if (!viewName.trim()) {
      setError("View name is required");
      return;
    }

    if (!viewOn) {
      setError("Source collection is required");
      return;
    }

    const parsedPipeline = validatePipeline(pipeline);
    if (!parsedPipeline) {
      setError("Invalid pipeline JSON format");
      return;
    }

    const viewDefinition = {
      name: viewName.trim(),
      viewOn: viewOn,
      pipeline: parsedPipeline,
    };

    onCreateView(viewDefinition);
  };

  const handleClose = () => {
    if (!isCreating) {
      onClose();
    }
  };

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      maxWidth="md"
      fullWidth
      PaperProps={{
        sx: {
          height: "80vh",
          maxHeight: "800px",
        },
      }}
    >
      <DialogTitle
        sx={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <Typography variant="h6">Create New View</Typography>
        <IconButton
          aria-label="close"
          onClick={handleClose}
          disabled={isCreating}
          sx={{
            color: theme => theme.palette.grey[500],
          }}
        >
          <CloseIcon />
        </IconButton>
      </DialogTitle>

      <DialogContent
        dividers
        sx={{ display: "flex", flexDirection: "column", gap: 2 }}
      >
        {error && (
          <Alert severity="error" onClose={() => setError(null)}>
            {error}
          </Alert>
        )}

        <TextField
          label="View Name"
          value={viewName}
          onChange={e => setViewName(e.target.value)}
          fullWidth
          required
          disabled={isCreating}
        />

        <FormControl fullWidth required disabled={isCreating}>
          <InputLabel>Source Collection</InputLabel>
          <Select
            value={viewOn}
            onChange={e => setViewOn(e.target.value)}
            label="Source Collection"
          >
            {collections.map(collection => (
              <MenuItem key={collection} value={collection}>
                {collection}
              </MenuItem>
            ))}
          </Select>
        </FormControl>

        <Box sx={{ flexGrow: 1, minHeight: "300px" }}>
          <Typography variant="subtitle2" gutterBottom>
            Aggregation Pipeline (JSON)
          </Typography>
          <Box
            sx={{
              height: "300px",
              border: 1,
              borderColor: "divider",
              borderRadius: 1,
            }}
          >
            <Editor
              defaultLanguage="json"
              value={pipeline}
              height="100%"
              theme={effectiveMode === "dark" ? "vs-dark" : "vs"}
              onChange={value => setPipeline(value || "")}
              options={{
                automaticLayout: true,
                readOnly: isCreating,
                minimap: { enabled: false },
                fontSize: 12,
                wordWrap: "on",
                scrollBeyondLastLine: false,
                formatOnPaste: true,
                formatOnType: true,
              }}
            />
          </Box>
        </Box>
      </DialogContent>

      <DialogActions>
        <Button onClick={handleClose} disabled={isCreating}>
          Cancel
        </Button>
        <Button
          onClick={handleCreate}
          variant="contained"
          disabled={isCreating || !viewName.trim() || !viewOn}
          disableElevation
        >
          {isCreating ? "Creating..." : "Create View"}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default CreateViewDialog;
