import {
  useRef,
  useEffect,
  useState,
  forwardRef,
  useImperativeHandle,
} from "react";
import {
  Box,
  Button,
  Typography,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
  Card,
  CardContent,
  Chip,
  Accordion,
  AccordionSummary,
  AccordionDetails,
} from "@mui/material";
import {
  PlayArrow,
  Info as InfoIcon,
  Add as AddIcon,
  Delete as DeleteIcon,
  ExpandMore as ExpandMoreIcon,
} from "@mui/icons-material";
import Editor from "@monaco-editor/react";
import { useTheme } from "../contexts/ThemeContext";

interface CollectionInfo {
  name: string;
  type: string;
  options: any;
  info: any;
}

interface CollectionEditorProps {
  collectionInfo: CollectionInfo | null;
  selectedCollection: string;
  onExecute: (query: string) => void;
  onCreate?: () => void;
  onDelete?: (collectionName: string) => void;
  isExecuting: boolean;
}

export interface CollectionEditorRef {
  createNew: () => void;
  cancelCreation: () => void;
  getCurrentContent: () => {
    content: string;
    fileName?: string;
    language?: string;
  };
}

const CollectionEditorComponent = (
  {
    collectionInfo,
    selectedCollection,
    onExecute,
    onCreate,
    onDelete,
    isExecuting,
  }: CollectionEditorProps,
  ref: React.Ref<CollectionEditorRef>,
) => {
  const editorRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const { effectiveMode } = useTheme();
  const [currentQuery, setCurrentQuery] = useState("");
  const [isCreatingNew, setIsCreatingNew] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [collectionDetails, setCollectionDetails] = useState<any>(null);
  const [_loadingDetails, setLoadingDetails] = useState(false);

  // Default query templates
  const queryTemplates = {
    findAll: `// Find all documents in the collection
db.${selectedCollection || "collection_name"}.find({})`,
    findWithFilter: `// Find documents with filter
db.${selectedCollection || "collection_name"}.find({
  // Add your filter criteria here
  // Example: { status: "active" }
})`,
    aggregate: `// Aggregation pipeline
db.${selectedCollection || "collection_name"}.aggregate([
  {
    $match: {
      // Add your match criteria here
    }
  },
  {
    $group: {
      _id: "$field_name",
      count: { $sum: 1 }
    }
  }
])`,
    count: `// Count documents
db.${selectedCollection || "collection_name"}.countDocuments({
  // Add filter criteria here if needed
})`,
  };

  // Load collection details when a collection is selected
  useEffect(() => {
    if (selectedCollection && !isCreatingNew) {
      fetchCollectionDetails();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCollection, isCreatingNew]);

  // Update query template when collection changes
  useEffect(() => {
    if (selectedCollection && !isCreatingNew) {
      setCurrentQuery(queryTemplates.findAll);
    } else if (isCreatingNew) {
      setCurrentQuery(`// Create a new collection
// Collection name: new_collection_name
db.createCollection("new_collection_name", {
  // Options (optional)
  capped: false,
  // size: 1000000,  // Size in bytes for capped collections
  // max: 5000       // Maximum number of documents for capped collections
})`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCollection, isCreatingNew]);

  const fetchCollectionDetails = async () => {
    if (!selectedCollection) return;

    try {
      setLoadingDetails(true);
      const response = await fetch(
        `/api/database/collections/${encodeURIComponent(
          selectedCollection,
        )}/info`,
      );
      const data = await response.json();

      if (data.success) {
        setCollectionDetails(data.data);
      }
    } catch (error) {
      console.error("Failed to fetch collection details:", error);
    } finally {
      setLoadingDetails(false);
    }
  };

  useEffect(() => {
    const handleResize = () => {
      if (editorRef.current) {
        editorRef.current.layout();
      }
    };

    const resizeObserver = new ResizeObserver(handleResize);
    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }

    return () => {
      resizeObserver.disconnect();
    };
  }, []);

  const handleEditorDidMount = (editor: any) => {
    editorRef.current = editor;
  };

  const handleEditorChange = (value: string | undefined) => {
    setCurrentQuery(value || "");
  };

  const handleExecute = () => {
    if (currentQuery.trim()) {
      onExecute(currentQuery);
    }
  };

  const handleCreateNew = () => {
    if (onCreate) {
      onCreate();
    } else {
      setIsCreatingNew(true);
    }
  };

  const handleCancelNew = () => {
    setIsCreatingNew(false);
    if (selectedCollection) {
      setCurrentQuery(queryTemplates.findAll);
    } else {
      setCurrentQuery("");
    }
  };

  const handleDelete = () => {
    setIsDeleting(true);
    setDeleteDialogOpen(true);
  };

  const handleDeleteConfirm = async () => {
    if (onDelete && selectedCollection && !isCreatingNew) {
      try {
        await onDelete(selectedCollection);
        setDeleteDialogOpen(false);
      } catch (error) {
        console.error("Failed to delete collection:", error);
      }
    }
    setIsDeleting(false);
    setDeleteDialogOpen(false);
  };

  const handleDeleteCancel = () => {
    setIsDeleting(false);
    setDeleteDialogOpen(false);
  };

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  };

  useImperativeHandle(ref, () => ({
    createNew: () => setIsCreatingNew(true),
    cancelCreation: () => setIsCreatingNew(false),
    getCurrentContent: () => ({
      content: currentQuery,
      fileName: selectedCollection,
      language: "javascript",
    }),
  }));

  const isShowingContent =
    selectedCollection || collectionInfo || isCreatingNew;
  const displayTitle = isCreatingNew
    ? "New Collection"
    : selectedCollection
      ? `Collection: ${selectedCollection}`
      : "No collection selected";

  return (
    <Box sx={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <Box
        sx={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          p: 1,
        }}
      >
        <Typography variant="h6">{displayTitle}</Typography>
        <Box sx={{ display: "flex", gap: 0.5 }}>
          {isCreatingNew && (
            <Button onClick={handleCancelNew} color="secondary">
              Cancel
            </Button>
          )}
          {(selectedCollection || isCreatingNew) && (
            <>
              <Button
                startIcon={<PlayArrow />}
                onClick={handleExecute}
                disabled={!currentQuery.trim() || isExecuting}
              >
                {isExecuting ? "Executing..." : "Run Query"}
              </Button>
              {selectedCollection && !isCreatingNew && onDelete && (
                <Button
                  startIcon={<DeleteIcon />}
                  onClick={handleDelete}
                  color="error"
                  disabled={isDeleting}
                >
                  Delete
                </Button>
              )}
            </>
          )}
        </Box>
      </Box>

      {/* Collection Information Panel */}
      {selectedCollection && !isCreatingNew && collectionDetails && (
        <Box sx={{ p: 1 }}>
          <Accordion>
            <AccordionSummary
              expandIcon={<ExpandMoreIcon />}
              aria-controls="collection-info-content"
              id="collection-info-header"
            >
              <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                <InfoIcon fontSize="small" />
                <Typography variant="subtitle2">
                  Collection Information
                </Typography>
              </Box>
            </AccordionSummary>
            <AccordionDetails>
              <Box sx={{ display: "flex", gap: 2, flexWrap: "wrap" }}>
                <Box sx={{ flex: 1, minWidth: 300 }}>
                  <Card variant="outlined">
                    <CardContent sx={{ p: 2, "&:last-child": { pb: 2 } }}>
                      <Typography variant="subtitle2" gutterBottom>
                        Statistics
                      </Typography>
                      <Box
                        sx={{
                          display: "flex",
                          flexDirection: "column",
                          gap: 0.5,
                        }}
                      >
                        <Typography variant="body2">
                          Documents:{" "}
                          <strong>
                            {collectionDetails.stats?.count?.toLocaleString() ||
                              0}
                          </strong>
                        </Typography>
                        <Typography variant="body2">
                          Size:{" "}
                          <strong>
                            {formatBytes(collectionDetails.stats?.size || 0)}
                          </strong>
                        </Typography>
                        <Typography variant="body2">
                          Avg Document Size:{" "}
                          <strong>
                            {formatBytes(
                              collectionDetails.stats?.avgObjSize || 0,
                            )}
                          </strong>
                        </Typography>
                        <Typography variant="body2">
                          Storage Size:{" "}
                          <strong>
                            {formatBytes(
                              collectionDetails.stats?.storageSize || 0,
                            )}
                          </strong>
                        </Typography>
                        <Typography variant="body2">
                          Indexes:{" "}
                          <strong>
                            {collectionDetails.stats?.indexes || 0}
                          </strong>
                        </Typography>
                      </Box>
                    </CardContent>
                  </Card>
                </Box>
                <Box sx={{ flex: 1, minWidth: 300 }}>
                  <Card variant="outlined">
                    <CardContent sx={{ p: 2, "&:last-child": { pb: 2 } }}>
                      <Typography variant="subtitle2" gutterBottom>
                        Options
                      </Typography>
                      <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5 }}>
                        {collectionDetails.options?.capped && (
                          <Chip label="Capped" size="small" color="warning" />
                        )}
                        {collectionDetails.type && (
                          <Chip
                            label={collectionDetails.type}
                            size="small"
                            color="default"
                          />
                        )}
                        {!collectionDetails.options?.capped &&
                          !collectionDetails.type && (
                            <Typography variant="body2" color="text.secondary">
                              No special options
                            </Typography>
                          )}
                      </Box>
                    </CardContent>
                  </Card>
                </Box>
              </Box>
            </AccordionDetails>
          </Accordion>
        </Box>
      )}

      <Box ref={containerRef} sx={{ flexGrow: 1, height: 0 }}>
        {isShowingContent ? (
          <Editor
            defaultLanguage="javascript"
            value={currentQuery}
            height="100%"
            theme={effectiveMode === "dark" ? "vs-dark" : "vs"}
            onMount={handleEditorDidMount}
            onChange={handleEditorChange}
            options={{
              automaticLayout: true,
              readOnly: false,
              minimap: { enabled: false },
              fontSize: 12,
              wordWrap: "on",
              scrollBeyondLastLine: false,
              formatOnPaste: true,
              formatOnType: true,
            }}
          />
        ) : (
          <Box
            sx={{
              height: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "text.secondary",
              flexDirection: "column",
              gap: 2,
            }}
          >
            <Typography>
              Select a collection from the explorer to view its information and
              run queries, or create a new collection
            </Typography>
            <Button
              startIcon={<AddIcon />}
              onClick={handleCreateNew}
              color="primary"
              variant="contained"
              disableElevation
            >
              New Collection
            </Button>
          </Box>
        )}
      </Box>

      <Dialog
        open={deleteDialogOpen}
        onClose={handleDeleteCancel}
        aria-labelledby="delete-dialog-title"
        aria-describedby="delete-dialog-description"
      >
        <DialogTitle id="delete-dialog-title">Delete Collection</DialogTitle>
        <DialogContent>
          <DialogContentText id="delete-dialog-description">
            Are you sure you want to delete the collection &quot;
            {selectedCollection}&quot;? This action cannot be undone and will
            permanently delete all documents in the collection.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleDeleteCancel} disabled={isDeleting}>
            Cancel
          </Button>
          <Button
            onClick={handleDeleteConfirm}
            color="error"
            variant="contained"
            disabled={isDeleting}
            disableElevation
          >
            {isDeleting ? "Deleting..." : "Delete"}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

const CollectionEditor = forwardRef<CollectionEditorRef, CollectionEditorProps>(
  CollectionEditorComponent,
);

export default CollectionEditor;
