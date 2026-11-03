import React, { useState, useEffect } from "react";
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  TextField,
  Box,
  Typography,
  IconButton,
  Alert,
  FormControlLabel,
  Switch,
  Accordion,
  AccordionSummary,
  AccordionDetails,
} from "@mui/material";
import {
  Close as CloseIcon,
  ExpandMore as ExpandMoreIcon,
} from "@mui/icons-material";

interface CreateCollectionDialogProps {
  open: boolean;
  onClose: () => void;
  onCreateCollection: (collectionDefinition: any) => void;
  isCreating: boolean;
}

const CreateCollectionDialog: React.FC<CreateCollectionDialogProps> = ({
  open,
  onClose,
  onCreateCollection,
  isCreating,
}) => {
  const [collectionName, setCollectionName] = useState("");
  const [isCapped, setIsCapped] = useState(false);
  const [cappedSize, setCappedSize] = useState<number>(1000000);
  const [cappedMaxDocs, setCappedMaxDocs] = useState<number>(5000);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      // Reset form when dialog opens
      setCollectionName("");
      setIsCapped(false);
      setCappedSize(1000000);
      setCappedMaxDocs(5000);
      setError(null);
    }
  }, [open]);

  const handleCreate = () => {
    setError(null);

    if (!collectionName.trim()) {
      setError("Collection name is required");
      return;
    }

    // Validate collection name (MongoDB naming rules)
    const nameRegex = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
    if (!nameRegex.test(collectionName.trim())) {
      setError(
        "Collection name must start with a letter or underscore and contain only letters, numbers, and underscores",
      );
      return;
    }

    if (isCapped) {
      if (cappedSize <= 0) {
        setError("Capped collection size must be greater than 0");
        return;
      }
      if (cappedMaxDocs <= 0) {
        setError("Capped collection max documents must be greater than 0");
        return;
      }
    }

    const collectionDefinition: any = {
      name: collectionName.trim(),
      options: {},
    };

    if (isCapped) {
      collectionDefinition.options.capped = true;
      collectionDefinition.options.size = cappedSize;
      collectionDefinition.options.max = cappedMaxDocs;
    }

    onCreateCollection(collectionDefinition);
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
      maxWidth="sm"
      fullWidth
      slotProps={{
        paper: {
          sx: {
            minHeight: "400px",
          },
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
        <Typography variant="h6">Create New Collection</Typography>
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
          label="Collection Name"
          value={collectionName}
          onChange={e => setCollectionName(e.target.value)}
          fullWidth
          required
          disabled={isCreating}
          helperText="Collection name must start with a letter or underscore and contain only letters, numbers, and underscores"
        />

        <Accordion>
          <AccordionSummary
            expandIcon={<ExpandMoreIcon />}
            aria-controls="capped-collection-content"
            id="capped-collection-header"
          >
            <Typography variant="subtitle1">
              Capped Collection Options
            </Typography>
          </AccordionSummary>
          <AccordionDetails>
            <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <FormControlLabel
                control={
                  <Switch
                    checked={isCapped}
                    onChange={e => setIsCapped(e.target.checked)}
                    disabled={isCreating}
                  />
                }
                label="Create as capped collection"
              />

              {isCapped && (
                <>
                  <Typography
                    variant="body2"
                    sx={{
                      color: "text.secondary",
                      mb: 1,
                    }}
                  >
                    Capped collections are fixed-size collections that maintain
                    insertion order and automatically remove the oldest
                    documents when the size limit is reached.
                  </Typography>

                  <TextField
                    label="Size (bytes)"
                    type="number"
                    value={cappedSize}
                    onChange={e => setCappedSize(parseInt(e.target.value) || 0)}
                    fullWidth
                    disabled={isCreating}
                    helperText="Maximum size of the collection in bytes"
                    slotProps={{
                      htmlInput: { min: 1 },
                    }}
                  />

                  <TextField
                    label="Max Documents"
                    type="number"
                    value={cappedMaxDocs}
                    onChange={e =>
                      setCappedMaxDocs(parseInt(e.target.value) || 0)
                    }
                    fullWidth
                    disabled={isCreating}
                    helperText="Maximum number of documents in the collection"
                    slotProps={{
                      htmlInput: { min: 1 },
                    }}
                  />
                </>
              )}
            </Box>
          </AccordionDetails>
        </Accordion>
      </DialogContent>

      <DialogActions>
        <Button onClick={handleClose} disabled={isCreating}>
          Cancel
        </Button>
        <Button
          onClick={handleCreate}
          variant="contained"
          disabled={isCreating || !collectionName.trim()}
          disableElevation
        >
          {isCreating ? "Creating..." : "Create Collection"}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default CreateCollectionDialog;
