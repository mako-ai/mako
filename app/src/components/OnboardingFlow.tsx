import { useEffect, useState, useCallback } from "react";
import {
  Box,
  Paper,
  Typography,
  Button,
  CircularProgress,
  Alert,
  Container,
  TextField,
  List,
  ListItem,
  ListItemIcon,
  ListItemText,
  ListItemSecondaryAction,
  Divider,
  Stack,
} from "@mui/material";
import {
  Business as BusinessIcon,
  Add as AddIcon,
  ArrowForward as ArrowForwardIcon,
} from "@mui/icons-material";
import { workspaceClient, type PendingInvite } from "../lib/workspace-client";
import { useWorkspace } from "../contexts/workspace-context";
import { trackEvent } from "../lib/analytics";

interface OnboardingFlowProps {
  onComplete: () => void;
}

type OnboardingState = "loading" | "choose" | "creating" | "error";

export function OnboardingFlow({ onComplete }: OnboardingFlowProps) {
  const { createWorkspace, acceptInvite } = useWorkspace();

  const [state, setState] = useState<OnboardingState>("loading");
  const [pendingInvites, setPendingInvites] = useState<PendingInvite[]>([]);
  const [workspaceName, setWorkspaceName] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [acceptingToken, setAcceptingToken] = useState<string | null>(null);

  // Load pending invites on mount
  useEffect(() => {
    const loadInvites = async () => {
      try {
        const invites = await workspaceClient.getPendingInvitesForUser();
        setPendingInvites(invites);
        setState("choose");
      } catch (error: any) {
        console.error("Failed to load pending invites:", error);
        // Even if we fail to load invites, show the create workspace option
        setState("choose");
      }
    };

    loadInvites();
  }, []);

  const handleAcceptInvite = useCallback(
    async (token: string) => {
      setAcceptingToken(token);
      setErrorMessage("");

      try {
        await acceptInvite(token);

        // Track onboarding completion via invite
        trackEvent("onboarding_completed", {
          has_pending_invites: pendingInvites.length > 0,
          action: "joined",
        });

        onComplete();
      } catch (error: any) {
        setErrorMessage(error.message || "Failed to accept invitation");
        setAcceptingToken(null);
      }
    },
    [acceptInvite, onComplete, pendingInvites.length],
  );

  const handleCreateWorkspace = useCallback(async () => {
    if (!workspaceName.trim()) {
      setErrorMessage("Workspace name is required");
      return;
    }

    setState("creating");
    setErrorMessage("");

    try {
      const workspace = await createWorkspace({ name: workspaceName.trim() });

      // Track workspace creation during onboarding
      trackEvent("workspace_created", {
        workspace_id: workspace.id,
        is_onboarding: true,
      });

      // Track onboarding completion
      trackEvent("onboarding_completed", {
        has_pending_invites: pendingInvites.length > 0,
        action: "created",
      });

      onComplete();
    } catch (error: any) {
      setErrorMessage(error.message || "Failed to create workspace");
      setState("choose");
    }
  }, [workspaceName, createWorkspace, onComplete, pendingInvites.length]);

  // Loading state
  if (state === "loading") {
    return (
      <Container maxWidth="sm">
        <Box
          sx={{
            minHeight: "100vh",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Paper sx={{ p: 4, width: "100%", textAlign: "center" }}>
            <CircularProgress size={60} sx={{ mb: 3 }} />
            <Typography variant="h5" gutterBottom>
              Setting Up Your Account
            </Typography>
            <Typography color="text.secondary">
              Please wait while we prepare your workspace options...
            </Typography>
          </Paper>
        </Box>
      </Container>
    );
  }

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
            <BusinessIcon color="primary" sx={{ fontSize: 60, mb: 2 }} />
            <Typography variant="h4" gutterBottom>
              Welcome!
            </Typography>
            <Typography color="text.secondary">
              Get started by joining an existing workspace or creating a new
              one.
            </Typography>
          </Box>

          {errorMessage && (
            <Alert severity="error" sx={{ mb: 3 }}>
              {errorMessage}
            </Alert>
          )}

          {/* Pending Invitations */}
          {pendingInvites.length > 0 && (
            <Box sx={{ mb: 4 }}>
              <Typography variant="h6" gutterBottom>
                Pending Invitations
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                You have been invited to join the following workspaces:
              </Typography>
              <List>
                {pendingInvites.map((invite, index) => (
                  <Box key={invite.token}>
                    {index > 0 && <Divider />}
                    <ListItem sx={{ py: 2 }}>
                      <ListItemIcon>
                        <BusinessIcon />
                      </ListItemIcon>
                      <ListItemText
                        primary={invite.workspaceName}
                        secondary={
                          <>
                            Invited by {invite.inviterEmail} • Role:{" "}
                            {invite.role}
                          </>
                        }
                      />
                      <ListItemSecondaryAction>
                        <Button
                          variant="contained"
                          size="small"
                          endIcon={
                            acceptingToken === invite.token ? (
                              <CircularProgress size={16} color="inherit" />
                            ) : (
                              <ArrowForwardIcon />
                            )
                          }
                          onClick={() => handleAcceptInvite(invite.token)}
                          disabled={acceptingToken !== null}
                        >
                          Join
                        </Button>
                      </ListItemSecondaryAction>
                    </ListItem>
                  </Box>
                ))}
              </List>
            </Box>
          )}

          {pendingInvites.length > 0 && <Divider sx={{ my: 3 }} />}

          {/* Create New Workspace */}
          <Box>
            <Typography variant="h6" gutterBottom>
              {pendingInvites.length > 0
                ? "Or Create a New Workspace"
                : "Create Your Workspace"}
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
              {pendingInvites.length > 0
                ? "Prefer to start fresh? Create your own workspace."
                : "Choose a name that represents your team, company, or project."}
            </Typography>

            <Stack spacing={2}>
              <TextField
                fullWidth
                label="Workspace Name"
                placeholder="e.g., Acme Corp, Engineering Team, Personal"
                value={workspaceName}
                onChange={e => setWorkspaceName(e.target.value)}
                disabled={state === "creating" || acceptingToken !== null}
                onKeyDown={e => {
                  if (e.key === "Enter" && workspaceName.trim()) {
                    handleCreateWorkspace();
                  }
                }}
                autoFocus={pendingInvites.length === 0}
                helperText="You can always change this later in settings"
              />
              <Button
                variant={pendingInvites.length > 0 ? "outlined" : "contained"}
                fullWidth
                size="large"
                startIcon={
                  state === "creating" ? (
                    <CircularProgress size={20} color="inherit" />
                  ) : (
                    <AddIcon />
                  )
                }
                onClick={handleCreateWorkspace}
                disabled={
                  state === "creating" ||
                  acceptingToken !== null ||
                  !workspaceName.trim()
                }
              >
                {state === "creating" ? "Creating..." : "Create Workspace"}
              </Button>
            </Stack>
          </Box>
        </Paper>
      </Box>
    </Container>
  );
}
