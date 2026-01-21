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
  ArrowBack as ArrowBackIcon,
} from "@mui/icons-material";
import { workspaceClient, type PendingInvite } from "../lib/workspace-client";
import { useWorkspace } from "../contexts/workspace-context";
import { trackEvent } from "../lib/analytics";
import { apiClient } from "../lib/api-client";
import {
  OnboardingProgress,
  QualificationStep,
  PathSelectionStep,
  type OnboardingStep,
  type QualificationData,
  type OnboardingPath,
} from "./onboarding";
import CreateDatabaseDialog from "./CreateDatabaseDialog";

interface OnboardingFlowProps {
  onComplete: () => void;
}

type OnboardingState =
  | "loading"
  | "choose-workspace"
  | "qualification"
  | "path"
  | "database"
  | "creating";

export function OnboardingFlow({ onComplete }: OnboardingFlowProps) {
  const {
    createWorkspaceForOnboarding,
    acceptInvite,
    currentWorkspace,
    refreshWorkspaces,
  } = useWorkspace();

  const [state, setState] = useState<OnboardingState>("loading");
  const [pendingInvites, setPendingInvites] = useState<PendingInvite[]>([]);
  const [workspaceName, setWorkspaceName] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [acceptingToken, setAcceptingToken] = useState<string | null>(null);
  const [qualificationData, setQualificationData] =
    useState<QualificationData | null>(null);
  const [_selectedPath, setSelectedPath] = useState<OnboardingPath | null>(
    null,
  );
  const [showDatabaseDialog, setShowDatabaseDialog] = useState(false);
  const [provisioningDemo, setProvisioningDemo] = useState(false);
  const [createdWorkspaceId, setCreatedWorkspaceId] = useState<string | null>(
    null,
  );

  // Check if we're resuming onboarding after a page refresh
  useEffect(() => {
    const onboardingInProgress = localStorage.getItem("onboarding_in_progress");
    const savedWorkspaceId = localStorage.getItem("onboarding_workspace_id");

    if (onboardingInProgress === "true" && savedWorkspaceId) {
      // Resume onboarding from qualification step
      setCreatedWorkspaceId(savedWorkspaceId);
      setState("qualification");
    }
  }, []);

  // Map state to step for progress indicator
  const getStep = (): OnboardingStep => {
    if (state === "qualification") return "qualification";
    if (state === "path") return "path";
    if (state === "database") return "database";
    return "qualification";
  };

  // Helper to clear onboarding state and complete
  const finishOnboarding = useCallback(() => {
    // Clear onboarding state from localStorage
    localStorage.removeItem("onboarding_in_progress");
    localStorage.removeItem("onboarding_workspace_id");
    onComplete();
  }, [onComplete]);

  // Load pending invites on mount
  useEffect(() => {
    const loadInvites = async () => {
      try {
        const invites = await workspaceClient.getPendingInvitesForUser();
        setPendingInvites(invites);
        setState("choose-workspace");
      } catch (error: unknown) {
        console.error("Failed to load pending invites:", error);
        // Even if we fail to load invites, show the create workspace option
        setState("choose-workspace");
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
        // Use > 1 to check for OTHER pending invites beyond the one being accepted
        trackEvent("onboarding_completed", {
          has_pending_invites: pendingInvites.length > 1,
          action: "joined",
        });

        finishOnboarding();
      } catch (error: unknown) {
        const err = error as Error;
        setErrorMessage(err.message || "Failed to accept invitation");
        setAcceptingToken(null);
      }
    },
    [acceptInvite, finishOnboarding, pendingInvites.length],
  );

  const handleCreateWorkspace = useCallback(async () => {
    if (!workspaceName.trim()) {
      setErrorMessage("Workspace name is required");
      return;
    }

    setState("creating");
    setErrorMessage("");

    try {
      // Use createWorkspaceForOnboarding to avoid page reload
      // This allows the multi-step onboarding flow to continue
      const workspace = await createWorkspaceForOnboarding({
        name: workspaceName.trim(),
      });
      setCreatedWorkspaceId(workspace.id);

      // Save onboarding state to localStorage in case of page refresh
      localStorage.setItem("onboarding_in_progress", "true");
      localStorage.setItem("onboarding_workspace_id", workspace.id);

      // Track workspace creation during onboarding
      trackEvent("workspace_created", {
        workspace_id: workspace.id,
        is_onboarding: true,
      });

      // Move to qualification step
      setState("qualification");
    } catch (error: unknown) {
      const err = error as Error;
      setErrorMessage(err.message || "Failed to create workspace");
      setState("choose-workspace");
    }
  }, [workspaceName, createWorkspaceForOnboarding]);

  const handleQualificationComplete = useCallback(
    async (data: QualificationData) => {
      setQualificationData(data);

      // Save qualification data to user profile
      try {
        await apiClient.put("/auth/onboarding", {
          role: data.role,
          companySize: data.companySize,
          databaseTypes: data.databaseTypes,
          hasNoDatabase: data.hasNoDatabase,
        });
      } catch (error) {
        console.error("Failed to save qualification data:", error);
        // Don't block progression if this fails
      }

      setState("path");
    },
    [],
  );

  const handlePathSelected = useCallback(
    async (path: OnboardingPath) => {
      setSelectedPath(path);

      if (path === "demo") {
        // Provision demo database
        setProvisioningDemo(true);
        setErrorMessage("");

        try {
          const workspaceId = createdWorkspaceId || currentWorkspace?.id;
          if (!workspaceId) {
            throw new Error("No workspace found");
          }

          await apiClient.post(`/workspaces/${workspaceId}/demo-database`);

          // Track demo database creation
          trackEvent("database_connection_created", {
            connection_type: "mongodb",
            isDemo: true,
          });

          // Refresh workspaces to get updated state
          await refreshWorkspaces();

          // Track onboarding completion
          trackEvent("onboarding_completed", {
            has_pending_invites: pendingInvites.length > 0,
            action: "created",
            path: "demo",
            qualification_role: qualificationData?.role,
            qualification_company_size: qualificationData?.companySize,
            qualification_has_no_database: qualificationData?.hasNoDatabase,
          });

          finishOnboarding();
        } catch (error: unknown) {
          const err = error as Error;
          setErrorMessage(err.message || "Failed to set up demo database");
          setProvisioningDemo(false);
        }
      } else {
        // Show database connection dialog
        setState("database");
      }
    },
    [
      createdWorkspaceId,
      currentWorkspace?.id,
      finishOnboarding,
      pendingInvites.length,
      qualificationData,
      refreshWorkspaces,
    ],
  );

  const handleDatabaseSuccess = useCallback(() => {
    setShowDatabaseDialog(false);

    // Track onboarding completion
    trackEvent("onboarding_completed", {
      has_pending_invites: pendingInvites.length > 0,
      action: "created",
      path: "connect",
      qualification_role: qualificationData?.role,
      qualification_company_size: qualificationData?.companySize,
      qualification_has_no_database: qualificationData?.hasNoDatabase,
    });

    finishOnboarding();
  }, [finishOnboarding, pendingInvites.length, qualificationData]);

  const handleBackToPath = useCallback(() => {
    setState("path");
  }, []);

  const handleBackToQualification = useCallback(() => {
    setState("qualification");
  }, []);

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

  // Provisioning demo state
  if (provisioningDemo) {
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
              Setting Up Demo Database
            </Typography>
            <Typography color="text.secondary">
              Provisioning your demo environment with sample e-commerce data...
            </Typography>
          </Paper>
        </Box>
      </Container>
    );
  }

  // Qualification step
  if (state === "qualification") {
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
            <OnboardingProgress currentStep={getStep()} />

            {errorMessage && (
              <Alert severity="error" sx={{ mb: 3 }}>
                {errorMessage}
              </Alert>
            )}

            <QualificationStep
              initialData={qualificationData || undefined}
              onComplete={handleQualificationComplete}
            />
          </Paper>
        </Box>
      </Container>
    );
  }

  // Path selection step
  if (state === "path" && qualificationData) {
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
            <OnboardingProgress currentStep={getStep()} />

            {errorMessage && (
              <Alert severity="error" sx={{ mb: 3 }}>
                {errorMessage}
              </Alert>
            )}

            <PathSelectionStep
              qualificationData={qualificationData}
              onSelectPath={handlePathSelected}
              onBack={handleBackToQualification}
            />
          </Paper>
        </Box>
      </Container>
    );
  }

  // Database setup step (connect real database)
  if (state === "database") {
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
            <OnboardingProgress currentStep={getStep()} />

            {errorMessage && (
              <Alert severity="error" sx={{ mb: 3 }}>
                {errorMessage}
              </Alert>
            )}

            <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 2 }}>
              <Button
                onClick={handleBackToPath}
                startIcon={<ArrowBackIcon />}
                size="small"
                sx={{ minWidth: "auto" }}
              >
                Back
              </Button>
            </Box>

            <Typography variant="h5" fontWeight={600} gutterBottom>
              Connect Your Database
            </Typography>
            <Typography color="text.secondary" sx={{ mb: 4 }}>
              {qualificationData?.databaseTypes &&
              qualificationData.databaseTypes.length > 0
                ? `Let's connect your ${qualificationData.databaseTypes[0].charAt(0).toUpperCase() + qualificationData.databaseTypes[0].slice(1)} database`
                : "Choose your database type and enter connection details"}
            </Typography>

            <Button
              variant="contained"
              size="large"
              fullWidth
              onClick={() => setShowDatabaseDialog(true)}
              sx={{ py: 1.5 }}
            >
              Add Database Connection
            </Button>

            <Typography
              variant="body2"
              color="text.secondary"
              sx={{ mt: 3, textAlign: "center" }}
            >
              You can also{" "}
              <Button
                variant="text"
                size="small"
                onClick={() => handlePathSelected("demo")}
                sx={{ textTransform: "none", p: 0, minWidth: "auto" }}
              >
                try with demo data first
              </Button>
            </Typography>

            <CreateDatabaseDialog
              open={showDatabaseDialog}
              onClose={() => setShowDatabaseDialog(false)}
              onSuccess={handleDatabaseSuccess}
            />
          </Paper>
        </Box>
      </Container>
    );
  }

  // Choose workspace step (existing flow for pending invites or creating new)
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
