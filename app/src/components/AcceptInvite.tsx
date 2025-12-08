import { useEffect, useState, useRef, useCallback } from "react";
import {
  Box,
  Paper,
  Typography,
  Button,
  CircularProgress,
  Alert,
  Container,
  Divider,
  Stack,
} from "@mui/material";
import {
  CheckCircle,
  Error as ErrorIcon,
  Email as EmailIcon,
  Business as BusinessIcon,
  Person as PersonIcon,
} from "@mui/icons-material";
import { useWorkspace } from "../contexts/workspace-context";
import { useAuth } from "../contexts/auth-context";
import { workspaceClient, type InviteDetails } from "../lib/workspace-client";

interface AcceptInviteProps {
  token: string;
}

type InviteState =
  | "loading"
  | "invite_details"
  | "email_mismatch"
  | "accepting"
  | "success"
  | "error"
  | "expired";

export function AcceptInvite({ token }: AcceptInviteProps) {
  const { acceptInvite } = useWorkspace();
  const { user, loading: authLoading, loginWithOAuth } = useAuth();

  const [state, setState] = useState<InviteState>("loading");
  const [inviteDetails, setInviteDetails] = useState<InviteDetails | null>(
    null,
  );
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [successWorkspace, setSuccessWorkspace] = useState<string>("");
  const loadedRef = useRef(false);

  // Load invite details on mount
  useEffect(() => {
    const loadInviteDetails = async () => {
      if (loadedRef.current) return;
      loadedRef.current = true;

      try {
        const details = await workspaceClient.getInviteDetails(token);
        setInviteDetails(details);

        // Check if invite is expired
        if (new Date(details.expiresAt) < new Date()) {
          setState("expired");
          return;
        }

        // If user is logged in, check email match
        if (!authLoading && user) {
          if (user.email.toLowerCase() === details.inviteeEmail.toLowerCase()) {
            setState("invite_details");
          } else {
            setState("email_mismatch");
          }
        } else {
          setState("invite_details");
        }
      } catch (error: any) {
        setErrorMessage(error.message || "Failed to load invitation");
        setState("error");
      }
    };

    loadInviteDetails();
  }, [token, authLoading, user]);

  // Re-check email match when auth state changes
  useEffect(() => {
    if (authLoading || !inviteDetails || state === "loading") return;

    if (user) {
      if (
        user.email.toLowerCase() === inviteDetails.inviteeEmail.toLowerCase()
      ) {
        setState("invite_details");
      } else {
        setState("email_mismatch");
      }
    } else {
      setState("invite_details");
    }
  }, [user, authLoading, inviteDetails, state]);

  const handleAcceptInvite = useCallback(async () => {
    if (!user) return;

    setState("accepting");
    try {
      const workspace = await acceptInvite(token);
      setSuccessWorkspace(workspace.name);
      setState("success");

      // Redirect to app after a short delay
      setTimeout(() => {
        window.location.href = "/";
      }, 2000);
    } catch (error: any) {
      setErrorMessage(error.message || "Failed to accept invitation");
      setState("error");
    }
  }, [token, acceptInvite, user]);

  const handleLogin = () => {
    // Store the current URL to redirect back after login
    sessionStorage.setItem("inviteRedirect", window.location.href);
    window.location.href = "/login";
  };

  const handleRegister = () => {
    // Store the current URL to redirect back after registration
    sessionStorage.setItem("inviteRedirect", window.location.href);
    window.location.href = `/register?email=${encodeURIComponent(inviteDetails?.inviteeEmail || "")}`;
  };

  const handleSwitchAccount = () => {
    // Logout and redirect to login
    sessionStorage.setItem("inviteRedirect", window.location.href);
    window.location.href = "/logout";
  };

  // Loading state
  if (state === "loading" || authLoading) {
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
              Loading Invitation
            </Typography>
            <Typography color="text.secondary">
              Please wait while we load your invitation...
            </Typography>
          </Paper>
        </Box>
      </Container>
    );
  }

  // Expired state
  if (state === "expired") {
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
            <ErrorIcon color="warning" sx={{ fontSize: 60, mb: 3 }} />
            <Typography variant="h5" gutterBottom>
              Invitation Expired
            </Typography>
            <Alert severity="warning" sx={{ mb: 3 }}>
              This invitation has expired. Please contact the workspace
              administrator to request a new invitation.
            </Alert>
            <Button
              variant="contained"
              onClick={() => (window.location.href = "/")}
            >
              Go to Home
            </Button>
          </Paper>
        </Box>
      </Container>
    );
  }

  // Error state
  if (state === "error") {
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
            <ErrorIcon color="error" sx={{ fontSize: 60, mb: 3 }} />
            <Typography variant="h5" gutterBottom>
              Invitation Error
            </Typography>
            <Alert severity="error" sx={{ mb: 3 }}>
              {errorMessage}
            </Alert>
            <Button
              variant="contained"
              onClick={() => (window.location.href = "/")}
            >
              Go to Home
            </Button>
          </Paper>
        </Box>
      </Container>
    );
  }

  // Success state
  if (state === "success") {
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
            <CheckCircle color="success" sx={{ fontSize: 60, mb: 3 }} />
            <Typography variant="h5" gutterBottom>
              Welcome to {successWorkspace}!
            </Typography>
            <Alert severity="success" sx={{ mb: 3 }}>
              You've successfully joined the workspace.
            </Alert>
            <Typography color="text.secondary">
              Redirecting to the application...
            </Typography>
          </Paper>
        </Box>
      </Container>
    );
  }

  // Accepting state
  if (state === "accepting") {
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
              Accepting Invitation
            </Typography>
            <Typography color="text.secondary">
              Please wait while we add you to the workspace...
            </Typography>
          </Paper>
        </Box>
      </Container>
    );
  }

  // Email mismatch state
  if (state === "email_mismatch") {
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
          <Paper sx={{ p: 4, width: "100%" }}>
            <Box sx={{ textAlign: "center", mb: 3 }}>
              <ErrorIcon color="warning" sx={{ fontSize: 60, mb: 2 }} />
              <Typography variant="h5" gutterBottom>
                Email Mismatch
              </Typography>
            </Box>

            <Alert severity="warning" sx={{ mb: 3 }}>
              This invitation was sent to{" "}
              <strong>{inviteDetails?.inviteeEmail}</strong>, but you're
              currently logged in as <strong>{user?.email}</strong>.
            </Alert>

            <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
              To accept this invitation, please log in with the email address
              the invitation was sent to.
            </Typography>

            <Stack spacing={2}>
              <Button
                variant="contained"
                fullWidth
                onClick={handleSwitchAccount}
              >
                Switch Account
              </Button>
              <Button
                variant="outlined"
                fullWidth
                onClick={() => (window.location.href = "/")}
              >
                Go to Home
              </Button>
            </Stack>
          </Paper>
        </Box>
      </Container>
    );
  }

  // Invite details state (default)
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
        <Paper sx={{ p: 4, width: "100%" }}>
          <Box sx={{ textAlign: "center", mb: 3 }}>
            <EmailIcon color="primary" sx={{ fontSize: 60, mb: 2 }} />
            <Typography variant="h5" gutterBottom>
              You're Invited!
            </Typography>
          </Box>

          <Box sx={{ mb: 3 }}>
            <Stack spacing={2}>
              <Box sx={{ display: "flex", alignItems: "center", gap: 2 }}>
                <BusinessIcon color="action" />
                <Box>
                  <Typography variant="body2" color="text.secondary">
                    Workspace
                  </Typography>
                  <Typography variant="body1" fontWeight="medium">
                    {inviteDetails?.workspaceName}
                  </Typography>
                </Box>
              </Box>

              <Box sx={{ display: "flex", alignItems: "center", gap: 2 }}>
                <PersonIcon color="action" />
                <Box>
                  <Typography variant="body2" color="text.secondary">
                    Invited by
                  </Typography>
                  <Typography variant="body1" fontWeight="medium">
                    {inviteDetails?.inviterEmail}
                  </Typography>
                </Box>
              </Box>

              <Box sx={{ display: "flex", alignItems: "center", gap: 2 }}>
                <EmailIcon color="action" />
                <Box>
                  <Typography variant="body2" color="text.secondary">
                    Invited email
                  </Typography>
                  <Typography variant="body1" fontWeight="medium">
                    {inviteDetails?.inviteeEmail}
                  </Typography>
                </Box>
              </Box>
            </Stack>
          </Box>

          <Divider sx={{ my: 3 }} />

          {user ? (
            // User is logged in and email matches
            <Stack spacing={2}>
              <Alert severity="info">
                You're logged in as <strong>{user.email}</strong>
              </Alert>
              <Button
                variant="contained"
                fullWidth
                size="large"
                onClick={handleAcceptInvite}
              >
                Accept Invitation
              </Button>
              <Button
                variant="outlined"
                fullWidth
                onClick={() => (window.location.href = "/")}
              >
                Decline
              </Button>
            </Stack>
          ) : (
            // User is not logged in
            <Stack spacing={2}>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                Please log in or create an account with{" "}
                <strong>{inviteDetails?.inviteeEmail}</strong> to accept this
                invitation.
              </Typography>

              <Button
                variant="contained"
                fullWidth
                size="large"
                onClick={handleLogin}
              >
                Log In
              </Button>

              <Button variant="outlined" fullWidth onClick={handleRegister}>
                Create Account
              </Button>

              <Divider sx={{ my: 1 }}>
                <Typography variant="body2" color="text.secondary">
                  or continue with
                </Typography>
              </Divider>

              <Stack direction="row" spacing={2}>
                <Button
                  variant="outlined"
                  fullWidth
                  onClick={() => loginWithOAuth("google")}
                >
                  Google
                </Button>
                <Button
                  variant="outlined"
                  fullWidth
                  onClick={() => loginWithOAuth("github")}
                >
                  GitHub
                </Button>
              </Stack>
            </Stack>
          )}
        </Paper>
      </Box>
    </Container>
  );
}
