import { useState, useCallback } from "react";
import {
  Box,
  Paper,
  Typography,
  Button,
  CircularProgress,
  Container,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Divider,
  Stack,
  Alert,
} from "@mui/material";
import { Building2, Plus, ChevronRight } from "lucide-react";
import { useWorkspace } from "../contexts/workspace-context";
import type { Workspace } from "../lib/workspace-client";

interface WorkspaceSelectorProps {
  workspaces: Workspace[];
  onCreateNew: () => void;
}

/**
 * Full-page workspace selector for users with multiple workspaces.
 * Displayed when user logs in and has 2+ workspaces without a persisted selection.
 */
export function WorkspaceSelector({
  workspaces,
  onCreateNew,
}: WorkspaceSelectorProps) {
  const { switchWorkspace } = useWorkspace();
  const [selectingId, setSelectingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleSelectWorkspace = useCallback(
    async (workspaceId: string) => {
      setSelectingId(workspaceId);
      setError(null);

      try {
        await switchWorkspace(workspaceId);
        // switchWorkspace handles the redirect/reload
      } catch (err: any) {
        setError(err.message || "Failed to switch workspace");
        setSelectingId(null);
      }
    },
    [switchWorkspace],
  );

  return (
    <Container maxWidth="sm">
      <Box
        sx={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          py: 4,
        }}
      >
        <Paper sx={{ p: 4, width: "100%" }}>
          <Box sx={{ textAlign: "center", mb: 4 }}>
            <Building2 size={60} style={{ marginBottom: 16 }} />
            <Typography variant="h4" gutterBottom>
              Select a Workspace
            </Typography>
            <Typography color="text.secondary">
              Choose which workspace you'd like to work in today.
            </Typography>
          </Box>

          {error && (
            <Alert severity="error" sx={{ mb: 3 }}>
              {error}
            </Alert>
          )}

          <List sx={{ mb: 3 }}>
            {workspaces.map((workspace, index) => (
              <Box key={workspace.id}>
                {index > 0 && <Divider />}
                <ListItemButton
                  onClick={() => handleSelectWorkspace(workspace.id)}
                  disabled={selectingId !== null}
                  sx={{
                    py: 2,
                    borderRadius: 1,
                    "&:hover": {
                      backgroundColor: "action.hover",
                    },
                  }}
                >
                  <ListItemIcon>
                    {selectingId === workspace.id ? (
                      <CircularProgress size={24} />
                    ) : (
                      <Building2 size={24} />
                    )}
                  </ListItemIcon>
                  <ListItemText
                    primary={workspace.name}
                    secondary={
                      workspace.slug ? `/${workspace.slug}` : undefined
                    }
                    primaryTypographyProps={{
                      fontWeight: "medium",
                    }}
                  />
                  <ChevronRight size={20} />
                </ListItemButton>
              </Box>
            ))}
          </List>

          <Divider sx={{ my: 3 }} />

          <Stack spacing={2}>
            <Typography
              variant="body2"
              color="text.secondary"
              textAlign="center"
            >
              Or start fresh with a new workspace
            </Typography>
            <Button
              variant="outlined"
              fullWidth
              size="large"
              startIcon={<Plus size={20} />}
              onClick={onCreateNew}
              disabled={selectingId !== null}
            >
              Create New Workspace
            </Button>
          </Stack>
        </Paper>
      </Box>
    </Container>
  );
}
