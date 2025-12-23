import { useState, useCallback, useMemo } from "react";
import {
  Box,
  Paper,
  Typography,
  Button,
  CircularProgress,
  Container,
  Divider,
  Stack,
  Alert,
  useTheme,
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
  const theme = useTheme();
  const { switchWorkspace } = useWorkspace();
  const [selectingId, setSelectingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sortedWorkspaces = useMemo(() => {
    return [...workspaces].sort((a, b) => a.name.localeCompare(b.name));
  }, [workspaces]);

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
        <Paper
          elevation={0}
          sx={{
            p: { xs: 3, sm: 5 },
            width: "100%",
            borderRadius: 3,
            border: "1px solid",
            borderColor: "divider",
          }}
        >
          <Box sx={{ textAlign: "center", mb: 5 }}>
            <Box
              component="img"
              src="/mako-icon.svg"
              alt="Mako"
              sx={{
                width: 64,
                height: "auto",
                margin: "0 auto",
                mb: 3,
                display: "block",
                filter:
                  theme.palette.mode === "dark"
                    ? "brightness(0) invert(1)"
                    : "none",
              }}
            />
            <Typography variant="h4" fontWeight="bold" gutterBottom>
              Select Workspace
            </Typography>
            <Typography color="text.secondary" variant="body1">
              Choose an existing workspace to continue your work
            </Typography>
          </Box>

          {error && (
            <Alert severity="error" sx={{ mb: 4, borderRadius: 2 }}>
              {error}
            </Alert>
          )}

          <Stack spacing={2} sx={{ mb: 4 }}>
            {sortedWorkspaces.map(workspace => (
              <Box
                key={workspace.id}
                component="button"
                onClick={() => handleSelectWorkspace(workspace.id)}
                disabled={selectingId !== null}
                sx={{
                  width: "100%",
                  textAlign: "left",
                  p: 3,
                  borderRadius: 2,
                  border: "1px solid",
                  borderColor: "divider",
                  bgcolor: "background.paper",
                  cursor: "pointer",
                  transition: "all 0.2s ease-in-out",
                  display: "flex",
                  alignItems: "center",
                  gap: 2,
                  "&:hover": {
                    borderColor: "text.primary",
                    bgcolor: "action.hover",
                  },
                  "&:disabled": {
                    opacity: 0.6,
                    cursor: "default",
                  },
                }}
              >
                <Box
                  sx={{
                    p: 1.5,
                    borderRadius: 1.5,
                    bgcolor: "action.selected",
                    color: "text.primary",
                    display: "flex",
                  }}
                >
                  {selectingId === workspace.id ? (
                    <CircularProgress size={24} thickness={4} />
                  ) : (
                    <Building2 size={24} strokeWidth={1.5} />
                  )}
                </Box>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography
                    variant="h6"
                    sx={{
                      fontSize: "1.05rem",
                      fontWeight: 600,
                      mb: 0.5,
                      color: "text.primary",
                    }}
                  >
                    {workspace.name}
                  </Typography>
                  {workspace.slug && (
                    <Typography variant="body2" color="text.secondary" noWrap>
                      /{workspace.slug}
                    </Typography>
                  )}
                </Box>
                <Box
                  sx={{
                    color: "text.secondary",
                    opacity: 0.4,
                    display: "flex",
                  }}
                >
                  <ChevronRight size={20} />
                </Box>
              </Box>
            ))}
          </Stack>

          <Box sx={{ position: "relative", my: 4 }}>
            <Divider />
            <Box
              sx={{
                position: "absolute",
                top: "50%",
                left: "50%",
                transform: "translate(-50%, -50%)",
                bgcolor: "background.paper",
                px: 2,
                color: "text.secondary",
                typography: "caption",
                fontWeight: 500,
              }}
            >
              OR
            </Box>
          </Box>

          <Button
            variant="text"
            fullWidth
            size="large"
            startIcon={<Plus size={20} />}
            onClick={onCreateNew}
            disabled={selectingId !== null}
            sx={{
              py: 1.5,
              textTransform: "none",
              fontSize: "1rem",
              fontWeight: 500,
              color: "text.primary",
              "&:hover": {
                bgcolor: "action.hover",
              },
            }}
          >
            Create new workspace
          </Button>
        </Paper>
      </Box>
    </Container>
  );
}
