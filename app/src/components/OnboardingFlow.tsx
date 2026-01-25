import { useEffect, useState, useCallback } from "react";
import {
  Box,
  Typography,
  Button,
  CircularProgress,
  Alert,
  TextField,
  List,
  ListItem,
  ListItemIcon,
  ListItemText,
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
import { useOnboarding } from "../contexts/onboarding-context";
import {
  QualificationStep,
  PathSelectionStep,
  type QualificationData,
  type OnboardingPath,
} from "./onboarding";
import CreateDatabaseDialog from "./CreateDatabaseDialog";
import { AuthLayout } from "./AuthLayout";
import { useSchemaStore } from "../store/schemaStore";

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

  const refreshConnections = useSchemaStore(s => s.refreshConnections);

  const [state, setState] = useState<OnboardingState>("loading");
  const [pendingInvites, setPendingInvites] = useState<PendingInvite[]>([]);
  const [workspaceName, setWorkspaceName] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [acceptingToken, setAcceptingToken] = useState<string | null>(null);
  const [qualificationData, setQualificationData] =
    useState<QualificationData | null>(null);
  const [showDatabaseDialog, setShowDatabaseDialog] = useState(false);
  const [provisioningDemo, setProvisioningDemo] = useState(false);
  const [createdWorkspaceId, setCreatedWorkspaceId] = useState<string | null>(
    null,
  );

  // Use shared onboarding context (shared with OnboardingGuard)
  const {
    isInProgress: onboardingInProgress,
    savedWorkspaceId,
    startOnboarding,
    completeOnboarding,
  } = useOnboarding();

  // Check if we're resuming onboarding after a page refresh
  const [isResumingOnboarding, setIsResumingOnboarding] = useState(
    () => onboardingInProgress && !!savedWorkspaceId,
  );

  useEffect(() => {
    if (isResumingOnboarding && savedWorkspaceId) {
      // Resume onboarding from qualification step
      setCreatedWorkspaceId(savedWorkspaceId);
      setState("qualification");
    }
  }, [isResumingOnboarding, savedWorkspaceId]);

  // Helper to clear onboarding state and complete
  const finishOnboarding = useCallback(() => {
    // Clear onboarding state using the hook
    completeOnboarding();
    setIsResumingOnboarding(false);
    onComplete();
  }, [completeOnboarding, onComplete]);

  // Helper to track onboarding completion with consistent properties
  const trackOnboardingCompleted = useCallback(
    (action: "joined" | "created", path?: "demo" | "connect") => {
      // For "joined", check > 1 because the accepted invite doesn't count
      // For "created", check > 0 since no invite is being consumed
      const hasPendingInvites =
        action === "joined"
          ? pendingInvites.length > 1
          : pendingInvites.length > 0;

      trackEvent("onboarding_completed", {
        has_pending_invites: hasPendingInvites,
        action,
        ...(path && { path }),
        ...(action === "created" &&
          qualificationData && {
            qualification_role: qualificationData.role,
            qualification_company_size: qualificationData.companySize,
            qualification_primary_database: qualificationData.primaryDatabase,
          }),
      });
    },
    [pendingInvites.length, qualificationData],
  );

  // Load pending invites on mount (only if not resuming onboarding)
  useEffect(() => {
    // Skip loading invites if we're resuming from a previous onboarding session
    if (isResumingOnboarding) {
      return;
    }

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
  }, [isResumingOnboarding]);

  const handleAcceptInvite = useCallback(
    async (token: string) => {
      setAcceptingToken(token);
      setErrorMessage("");

      try {
        await acceptInvite(token);

        trackOnboardingCompleted("joined");
        finishOnboarding();
      } catch (error: unknown) {
        const err = error as Error;
        setErrorMessage(err.message || "Failed to accept invitation");
        setAcceptingToken(null);
      }
    },
    [acceptInvite, finishOnboarding, trackOnboardingCompleted],
  );

  const handleCreateWorkspace = useCallback(async () => {
    if (!workspaceName.trim()) {
      setErrorMessage("Workspace name is required");
      return;
    }

    setState("creating");
    setErrorMessage("");

    // Mark onboarding in progress BEFORE creating workspace (no ID yet).
    // This ensures OnboardingGuard keeps showing OnboardingFlow when
    // the workspace list updates (both share the same context state).
    startOnboarding();

    try {
      const workspace = await createWorkspaceForOnboarding({
        name: workspaceName.trim(),
      });
      setCreatedWorkspaceId(workspace.id);

      // Now save the real workspace ID (for page refresh resume)
      startOnboarding(workspace.id);

      trackEvent("workspace_created", {
        workspace_id: workspace.id,
        is_onboarding: true,
      });

      setState("qualification");
    } catch (error: unknown) {
      const err = error as Error;
      setErrorMessage(err.message || "Failed to create workspace");
      completeOnboarding();
      setState("choose-workspace");
    }
  }, [
    workspaceName,
    createWorkspaceForOnboarding,
    startOnboarding,
    completeOnboarding,
  ]);

  const handleQualificationComplete = useCallback(
    async (data: QualificationData) => {
      setQualificationData(data);

      // Save qualification data to user profile
      try {
        await apiClient.put("/auth/onboarding", {
          role: data.role,
          companySize: data.companySize,
          primaryDatabase: data.primaryDatabase,
          dataWarehouse: data.dataWarehouse,
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
      if (path === "demo") {
        // Provision demo database
        setProvisioningDemo(true);
        setErrorMessage("");

        try {
          const workspaceId = createdWorkspaceId || currentWorkspace?.id;
          if (!workspaceId) {
            throw new Error("No workspace found");
          }

          await apiClient.post(`/workspaces/${workspaceId}/databases/demo`);

          // Refresh workspaces to get updated state
          await refreshWorkspaces();

          // Refresh database connections so the explorer shows the new demo database
          await refreshConnections(workspaceId);

          trackOnboardingCompleted("created", "demo");
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
      trackOnboardingCompleted,
      refreshWorkspaces,
      refreshConnections,
    ],
  );

  const handleDatabaseSuccess = useCallback(() => {
    setShowDatabaseDialog(false);

    trackOnboardingCompleted("created", "connect");
    finishOnboarding();
  }, [finishOnboarding, trackOnboardingCompleted]);

  const handleBackToPath = useCallback(() => {
    setState("path");
  }, []);

  const handleBackToQualification = useCallback(() => {
    setState("qualification");
  }, []);

  // Loading state
  if (state === "loading") {
    return (
      <AuthLayout title="Setting Up Your Account" subtitle="Please wait...">
        <Box sx={{ textAlign: "center", py: 4 }}>
          <CircularProgress size={60} />
        </Box>
      </AuthLayout>
    );
  }

  // Provisioning demo state
  if (provisioningDemo) {
    return (
      <AuthLayout
        title="Setting Up Demo Database"
        subtitle="Provisioning your demo environment with sample e-commerce data..."
      >
        <Box sx={{ textAlign: "center", py: 4 }}>
          <CircularProgress size={60} />
        </Box>
      </AuthLayout>
    );
  }

  // Qualification step
  if (state === "qualification") {
    return (
      <AuthLayout title="" subtitle="">
        {errorMessage && (
          <Alert severity="error" sx={{ mb: 3 }}>
            {errorMessage}
          </Alert>
        )}

        <QualificationStep
          initialData={qualificationData || undefined}
          onComplete={handleQualificationComplete}
        />
      </AuthLayout>
    );
  }

  // Path selection step
  if (state === "path" && qualificationData) {
    return (
      <AuthLayout title="" subtitle="">
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
      </AuthLayout>
    );
  }

  // Database setup step (connect real database)
  if (state === "database") {
    const dbSubtitle =
      qualificationData?.primaryDatabase &&
      qualificationData.primaryDatabase !== "none"
        ? `Let's connect your ${qualificationData.primaryDatabase.charAt(0).toUpperCase() + qualificationData.primaryDatabase.slice(1)} database`
        : "Choose your database type and enter connection details";

    return (
      <AuthLayout title="Connect Your Database" subtitle={dbSubtitle}>
        {errorMessage && (
          <Alert severity="error" sx={{ mb: 3 }}>
            {errorMessage}
          </Alert>
        )}

        <Box sx={{ mb: 3 }}>
          <Button
            onClick={handleBackToPath}
            startIcon={<ArrowBackIcon />}
            size="small"
            sx={{ minWidth: "auto" }}
          >
            Back
          </Button>
        </Box>

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
      </AuthLayout>
    );
  }

  // Choose workspace step (existing flow for pending invites or creating new)
  const hasInvites = pendingInvites.length > 0;

  return (
    <AuthLayout
      title={hasInvites ? "Welcome!" : "Create your workspace"}
      subtitle={
        hasInvites
          ? "Get started by joining an existing workspace or creating a new one."
          : "Choose a name that represents your team, company, or project."
      }
    >
      {errorMessage && (
        <Alert severity="error" sx={{ mb: 3 }}>
          {errorMessage}
        </Alert>
      )}

      {/* Pending Invitations - only show if there are invites */}
      {hasInvites && (
        <>
          <Box sx={{ mb: 3 }}>
            <Typography
              variant="subtitle2"
              fontWeight={600}
              color="text.secondary"
              sx={{ mb: 2, textTransform: "uppercase", letterSpacing: 0.5 }}
            >
              Pending Invitations
            </Typography>
            <List disablePadding>
              {pendingInvites.map((invite, index) => (
                <Box key={invite.token}>
                  {index > 0 && <Divider />}
                  <ListItem sx={{ py: 2, px: 0 }}>
                    <ListItemIcon sx={{ minWidth: 40 }}>
                      <BusinessIcon />
                    </ListItemIcon>
                    <ListItemText
                      primary={invite.workspaceName}
                      secondary={`Invited by ${invite.inviterEmail} • ${invite.role}`}
                    />
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
                  </ListItem>
                </Box>
              ))}
            </List>
          </Box>

          <Divider sx={{ my: 3 }} />

          <Typography
            variant="subtitle2"
            fontWeight={600}
            color="text.secondary"
            sx={{ mb: 2, textTransform: "uppercase", letterSpacing: 0.5 }}
          >
            Or create new
          </Typography>
        </>
      )}

      {/* Create New Workspace Form */}
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
          autoFocus={!hasInvites}
          helperText="You can always change this later in settings"
        />
        <Button
          variant={hasInvites ? "outlined" : "contained"}
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
    </AuthLayout>
  );
}
