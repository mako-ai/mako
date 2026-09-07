import { useEffect } from "react";
import { Box, Typography } from "@mui/material";
import { useAuth } from "../contexts/auth-context";
import { useWorkspace } from "../contexts/workspace-context";

/**
 * The "veuillez attendre qu'un administrateur finalise votre inscription"
 * screen for a member who auto-joined by email domain and has no job role
 * yet (apps.md §27). Must render INSIDE WorkspaceProvider (AuthWrapper does
 * that). Re-reads the workspace list every 20 s and lets them through the
 * moment an admin sets the role.
 */
export function PendingProfileGate({
  children,
}: {
  children: React.ReactNode;
}) {
  const { currentWorkspace, refreshWorkspaces } = useWorkspace();
  const { user } = useAuth();
  const pending = !!currentWorkspace?.profilePending;
  useEffect(() => {
    if (!pending) return;
    const id = window.setInterval(() => void refreshWorkspaces(), 20_000);
    return () => window.clearInterval(id);
  }, [pending, refreshWorkspaces]);
  if (!pending) return <>{children}</>;
  return (
    <Box
      sx={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        bgcolor: "background.default",
        p: 3,
      }}
    >
      <Box
        sx={{
          maxWidth: 520,
          p: 4,
          border: "1px solid",
          borderColor: "divider",
          borderRadius: 3,
          bgcolor: "background.paper",
        }}
      >
        <Typography variant="h6" sx={{ mb: 1.5 }}>
          Veuillez attendre qu&apos;un administrateur finalise votre inscription
        </Typography>
        <Typography variant="body2" sx={{ mb: 1 }}>
          Vous êtes connecté à <b>{currentWorkspace?.name}</b> en tant que{" "}
          <b>{user?.email}</b>. Un administrateur doit encore vous attribuer un
          rôle et un pays.
        </Typography>
        <Typography variant="body2" sx={{ mb: 2 }}>
          Les administrateurs ont été prévenus. Vous recevrez un email dès que
          c&apos;est fait — cette page se met à jour toute seule.
        </Typography>
        <Typography variant="caption" color="text.secondary">
          Please wait for an administrator to finish your signup. This page
          updates itself.
        </Typography>
      </Box>
    </Box>
  );
}
