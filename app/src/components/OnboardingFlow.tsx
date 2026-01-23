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
  ArrowForward as ArrowForwardIcon,
  ArrowBack as ArrowBackIcon,
} from "@mui/icons-material";
import { workspaceClient, type PendingInvite } from "../lib/workspace-client";
import { apiClient } from "../lib/api-client";
import { useWorkspace } from "../contexts/workspace-context";
import { trackEvent } from "../lib/analytics";
import {
  OnboardingProgress,
  QualificationStep,
  PathSelectionStep,
  type OnboardingStep,
  type QualificationData,
  type OnboardingData,
} from "./onboarding";
import { CreateDatabaseDialog } from "./CreateDatabaseDialog";

interface OnboardingFlowProps {
  onComplete: () => void;
}

export function OnboardingFlow({ onComplete }: OnboardingFlowProps) {
  const { createWorkspace, acceptInvite, switchWorkspace } = useWorkspace();

  // Step state
  const [step, setStep] = useState<OnboardingStep>("loading");
  const [pendingInvites, setPendingInvites] = useState<PendingInvite[]>([]);

  // Onboarding data
  const [onboardingData, setOnboardingData] = useState<OnboardingData>({});
  const [workspaceName, setWorkspaceName] = useState("");
  const [createdWorkspaceId, setCreatedWorkspaceId] = useState<string | null>(
    null,
  );

  // UI state
  const [errorMessage, setErrorMessage] = useState("");
  const [acceptingToken, setAcceptingToken] = useState<string | null>(null);
  const [isProvisioning, setIsProvisioning] = useState(false);
  const [showDatabaseDialog, setShowDatabaseDialog] = useState(false);

  // Load pending invites on mount
  useEffect(() => {
    const loadInvites = async () => {
      try {
        const invites = await workspaceClient.getPendingInvitesForUser();
        setPendingInvites(invites);
        // If user has pending invites, show them first
        if (invites.length > 0) {
          setStep("invites");
        } else {
          // Otherwise, start with qualification
          setStep("qualification");
        }
      } catch (error: any) {
        console.error("Failed to load pending invites:", error);
        // Even if we fail to load invites, start with qualification
        setStep("qualification");
      }
    };

    loadInvites();
  }, []);

  // Save onboarding data to user profile
  const saveOnboardingData = async (data: Partial<OnboardingData>) => {
    try {
      await apiClient.patch("/auth/me/onboarding", data);
    } catch (error) {
      console.error("Failed to save onboarding data:", error);
      // Non-critical, don't block the flow
    }
  };

  // Handle accept invite
  const handleAcceptInvite = useCallback(
    async (token: string) => {
      setAcceptingToken(token);
      setErrorMessage("");

      try {
        await acceptInvite(token);

        trackEvent("onboarding_completed", {
          has_pending_invites: pendingInvites.length > 1,
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

  // Handle skip invites and start fresh
  const handleSkipInvites = () => {
    setStep("qualification");
  };

  // Handle qualification complete
  const handleQualificationComplete = async (data: QualificationData) => {
    setOnboardingData(prev => ({ ...prev, ...data }));
    await saveOnboardingData(data);
    setStep("path-selection");
  };

  // Handle path selection
  const handlePathSelection = async (path: "demo" | "connect") => {
    setOnboardingData(prev => ({ ...prev, selectedPath: path }));
    setErrorMessage("");

    if (path === "demo") {
      // Create workspace and provision demo database
      setIsProvisioning(true);
      try {
        // Generate a workspace name if not set
        const name = workspaceName.trim() || "My Workspace";

        // Create workspace first
        const workspace = await createWorkspace({ name });
        setCreatedWorkspaceId(workspace.id);

        // Track workspace creation
        trackEvent("workspace_created", {
          workspace_id: workspace.id,
          is_onboarding: true,
        });

        // Switch to the new workspace
        await switchWorkspace(workspace.id);

        // Provision demo database
        await workspaceClient.provisionDemoDatabase(workspace.id);

        // Track demo database creation
        trackEvent("database_connection_created", {
          connection_type: "mongodb",
          isDemo: true,
        });

        // Mark onboarding as complete
        await saveOnboardingData({
          completedAt: new Date().toISOString(),
        } as any);

        trackEvent("onboarding_completed", {
          has_pending_invites: pendingInvites.length > 0,
          action: "demo",
          path: "demo",
        });

        onComplete();
      } catch (error: any) {
        console.error("Failed to provision demo:", error);
        setErrorMessage(error.message || "Failed to set up demo database");
        setIsProvisioning(false);
      }
    } else {
      // Connect own database - show database dialog after creating workspace
      setStep("database-setup");
    }
  };

  // Handle workspace creation for connect path
  const handleCreateWorkspaceForConnect = async () => {
    if (!workspaceName.trim()) {
      setErrorMessage("Please enter a workspace name");
      return;
    }

    setStep("creating");
    setErrorMessage("");

    try {
      const workspace = await createWorkspace({ name: workspaceName.trim() });
      setCreatedWorkspaceId(workspace.id);

      trackEvent("workspace_created", {
        workspace_id: workspace.id,
        is_onboarding: true,
      });

      // Switch to the new workspace
      await switchWorkspace(workspace.id);

      // Show database connection dialog
      setShowDatabaseDialog(true);
    } catch (error: any) {
      setErrorMessage(error.message || "Failed to create workspace");
      setStep("database-setup");
    }
  };

  // Handle database creation complete
  const handleDatabaseCreated = async () => {
    setShowDatabaseDialog(false);

    // Mark onboarding as complete
    await saveOnboardingData({
      completedAt: new Date().toISOString(),
    } as any);

    trackEvent("onboarding_completed", {
      has_pending_invites: pendingInvites.length > 0,
      action: "connected",
      path: "connect",
    });

    onComplete();
  };

  // Handle skip database setup (create workspace without database)
  const handleSkipDatabaseSetup = async () => {
    if (!workspaceName.trim()) {
      setErrorMessage("Please enter a workspace name");
      return;
    }

    setStep("creating");
    setErrorMessage("");

    try {
      const workspace = await createWorkspace({ name: workspaceName.trim() });

      trackEvent("workspace_created", {
        workspace_id: workspace.id,
        is_onboarding: true,
      });

      trackEvent("onboarding_completed", {
        has_pending_invites: pendingInvites.length > 0,
        action: "skipped",
        path: "skip",
      });

      await saveOnboardingData({
        completedAt: new Date().toISOString(),
      } as any);

      onComplete();
    } catch (error: any) {
      setErrorMessage(error.message || "Failed to create workspace");
      setStep("database-setup");
    }
  };

  // Calculate current step number for progress indicator
  const getStepNumber = () => {
    switch (step) {
      case "qualification":
        return 0;
      case "path-selection":
        return 1;
      case "database-setup":
      case "creating":
        return 2;
      default:
        return 0;
    }
  };

  // Loading state
  if (step === "loading") {
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

  // Pending invites step
  if (step === "invites") {
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
                You've been invited to join a workspace.
              </Typography>
            </Box>

            {errorMessage && (
              <Alert severity="error" sx={{ mb: 3 }}>
                {errorMessage}
              </Alert>
            )}

            <Box sx={{ mb: 4 }}>
              <Typography variant="h6" gutterBottom>
                Pending Invitations
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

            <Divider sx={{ my: 3 }} />

            <Button
              variant="outlined"
              fullWidth
              onClick={handleSkipInvites}
              disabled={acceptingToken !== null}
            >
              Create a new workspace instead
            </Button>
          </Paper>
        </Box>
      </Container>
    );
  }

  // Creating state
  if (step === "creating") {
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
              Creating Your Workspace
            </Typography>
            <Typography color="text.secondary">
              Setting up "{workspaceName || "My Workspace"}"...
            </Typography>
          </Paper>
        </Box>
      </Container>
    );
  }

  // Multi-step onboarding flow
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
          {/* Progress indicator */}
          {(step === "qualification" ||
            step === "path-selection" ||
            step === "database-setup") && (
            <OnboardingProgress currentStep={getStepNumber()} totalSteps={3} />
          )}

          {errorMessage && (
            <Alert severity="error" sx={{ mb: 3 }}>
              {errorMessage}
            </Alert>
          )}

          {/* Qualification Step */}
          {step === "qualification" && (
            <QualificationStep
              initialData={onboardingData}
              onComplete={handleQualificationComplete}
            />
          )}

          {/* Path Selection Step */}
          {step === "path-selection" && (
            <>
              <PathSelectionStep
                qualificationData={onboardingData}
                onSelectPath={handlePathSelection}
                isProvisioning={isProvisioning}
              />
              <Button
                startIcon={<ArrowBackIcon />}
                onClick={() => setStep("qualification")}
                disabled={isProvisioning}
                sx={{ mt: 2 }}
              >
                Back
              </Button>
            </>
          )}

          {/* Database Setup Step */}
          {step === "database-setup" && (
            <Box>
              <Typography variant="h5" gutterBottom sx={{ mb: 3 }}>
                Set up your workspace
              </Typography>
              <Typography color="text.secondary" sx={{ mb: 4 }}>
                Give your workspace a name and connect your database.
              </Typography>

              <Stack spacing={3}>
                <TextField
                  fullWidth
                  label="Workspace Name"
                  placeholder="e.g., Acme Corp, Engineering Team"
                  value={workspaceName}
                  onChange={e => setWorkspaceName(e.target.value)}
                  helperText="You can always change this later"
                  autoFocus
                />

                <Button
                  variant="contained"
                  size="large"
                  fullWidth
                  onClick={handleCreateWorkspaceForConnect}
                  disabled={!workspaceName.trim()}
                >
                  Continue to Connect Database
                </Button>

                <Button
                  variant="text"
                  size="small"
                  onClick={handleSkipDatabaseSetup}
                  disabled={!workspaceName.trim()}
                  sx={{ color: "text.secondary" }}
                >
                  Skip for now - I'll connect later
                </Button>

                <Button
                  startIcon={<ArrowBackIcon />}
                  onClick={() => setStep("path-selection")}
                  sx={{ alignSelf: "flex-start" }}
                >
                  Back
                </Button>
              </Stack>
            </Box>
          )}
        </Paper>
      </Box>

      {/* Database Connection Dialog */}
      {showDatabaseDialog && createdWorkspaceId && (
        <CreateDatabaseDialog
          open={showDatabaseDialog}
          onClose={() => {
            setShowDatabaseDialog(false);
            // Even if they close without creating, complete onboarding
            handleDatabaseCreated();
          }}
          onSuccess={handleDatabaseCreated}
        />
      )}
    </Container>
  );
}
