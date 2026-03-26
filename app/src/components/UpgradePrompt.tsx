/**
 * UpgradePrompt - Shown when an agent request is blocked by billing limits
 *
 * Displays an inline prompt explaining why the request was blocked
 * and providing an upgrade button.
 */

import { Typography, Button, Alert, AlertTitle } from "@mui/material";
import { Sparkles } from "lucide-react";
import { useWorkspace } from "../contexts/workspace-context";
import { useBillingStore } from "../store/billingStore";

interface UpgradePromptProps {
  errorCode: string;
  message: string;
  plan?: string;
  currentUsageUsd?: number;
  quotaUsd?: number;
  onDismiss?: () => void;
}

export function UpgradePrompt({
  errorCode,
  message,
  plan,
  onDismiss,
}: UpgradePromptProps) {
  const { currentWorkspace } = useWorkspace();
  const { createCheckoutSession } = useBillingStore();

  const isUsageLimit = errorCode === "usage_limit_exceeded";

  const handleUpgrade = async () => {
    if (!currentWorkspace?.id) return;
    const url = await createCheckoutSession(currentWorkspace.id);
    if (url) window.location.href = url;
  };

  return (
    <Alert
      severity={isUsageLimit ? "warning" : "info"}
      sx={{ my: 1 }}
      onClose={onDismiss}
    >
      <AlertTitle sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
        <Sparkles size={16} />
        {isUsageLimit ? "Usage Limit Reached" : "Pro Model"}
      </AlertTitle>
      <Typography variant="body2" sx={{ mb: 1.5 }}>
        {message}
      </Typography>
      {plan === "free" && (
        <Button
          size="small"
          variant="contained"
          onClick={handleUpgrade}
          disableElevation
        >
          Upgrade to Pro
        </Button>
      )}
    </Alert>
  );
}
