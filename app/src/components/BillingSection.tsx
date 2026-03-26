/**
 * BillingSection - Settings page billing panel
 *
 * Displays current plan, usage progress, and upgrade/manage buttons.
 * When billing is disabled (self-hosted), shows a simple "unlimited" message.
 */

import { useEffect } from "react";
import {
  Box,
  Typography,
  Button,
  LinearProgress,
  Chip,
  Alert,
  Skeleton,
} from "@mui/material";
import { CreditCard, ExternalLink } from "lucide-react";
import { useWorkspace } from "../contexts/workspace-context";
import { useBillingStore } from "../store/billingStore";

export function BillingSection() {
  const { currentWorkspace } = useWorkspace();
  const {
    status,
    isLoading,
    error,
    fetchBillingStatus,
    createCheckoutSession,
    createPortalSession,
  } = useBillingStore();

  useEffect(() => {
    if (currentWorkspace?.id) {
      fetchBillingStatus(currentWorkspace.id);
    }
  }, [currentWorkspace?.id, fetchBillingStatus]);

  if (isLoading && !status) {
    return (
      <Box>
        <Typography
          variant="subtitle1"
          gutterBottom
          sx={{ fontWeight: 600, mb: 2 }}
        >
          Billing
        </Typography>
        <Skeleton variant="rectangular" height={120} />
      </Box>
    );
  }

  if (!status) return null;

  // When billing is disabled (self-hosted mode)
  if (!status.billingEnabled) {
    return (
      <Box>
        <Typography
          variant="subtitle1"
          gutterBottom
          sx={{ fontWeight: 600, mb: 2 }}
        >
          Billing
        </Typography>
        <Alert severity="info" sx={{ mb: 2 }}>
          Billing is not enabled. All features are available without
          restrictions.
        </Alert>
      </Box>
    );
  }

  const usagePercent =
    status.usageQuotaUsd > 0
      ? Math.min(100, (status.currentUsageUsd / status.usageQuotaUsd) * 100)
      : 0;

  const isOverQuota = status.currentUsageUsd >= status.usageQuotaUsd;

  const planLabel = status.plan.charAt(0).toUpperCase() + status.plan.slice(1);
  const planColor =
    status.plan === "pro"
      ? "primary"
      : status.plan === "enterprise"
        ? "secondary"
        : "default";

  const handleUpgrade = async () => {
    if (!currentWorkspace?.id) return;
    const url = await createCheckoutSession(currentWorkspace.id);
    if (url) window.location.href = url;
  };

  const handleManageBilling = async () => {
    if (!currentWorkspace?.id) return;
    const url = await createPortalSession(currentWorkspace.id);
    if (url) window.location.href = url;
  };

  return (
    <Box>
      <Typography
        variant="subtitle1"
        gutterBottom
        sx={{ fontWeight: 600, mb: 2 }}
      >
        Billing
      </Typography>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {/* Plan Info */}
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1.5,
          mb: 2,
        }}
      >
        <CreditCard size={20} />
        <Typography variant="body1">Current Plan:</Typography>
        <Chip label={planLabel} color={planColor as any} size="small" />
        {status.subscriptionStatus &&
          status.subscriptionStatus !== "active" && (
            <Chip
              label={status.subscriptionStatus}
              color="warning"
              size="small"
              variant="outlined"
            />
          )}
      </Box>

      {/* Usage Bar */}
      <Box sx={{ mb: 2 }}>
        <Box sx={{ display: "flex", justifyContent: "space-between", mb: 0.5 }}>
          <Typography variant="body2" color="text.secondary">
            AI Usage this period
          </Typography>
          <Typography variant="body2" color="text.secondary">
            ${status.currentUsageUsd.toFixed(2)} / $
            {status.usageQuotaUsd.toFixed(2)}
          </Typography>
        </Box>
        <LinearProgress
          variant="determinate"
          value={usagePercent}
          color={isOverQuota ? "error" : "primary"}
          sx={{ height: 8, borderRadius: 4 }}
        />
        <Box sx={{ display: "flex", justifyContent: "space-between", mt: 0.5 }}>
          <Typography variant="caption" color="text.secondary">
            {status.invocationCount} requests
          </Typography>
          {status.plan !== "free" && status.hardLimitUsd == null && (
            <Typography variant="caption" color="text.secondary">
              Overage billed at cost
            </Typography>
          )}
        </Box>
      </Box>

      {/* Upgrade / Manage Buttons */}
      <Box sx={{ display: "flex", gap: 1 }}>
        {status.plan === "free" && (
          <Button variant="contained" onClick={handleUpgrade} disableElevation>
            Upgrade to Pro
          </Button>
        )}
        {status.hasStripeCustomer && (
          <Button
            variant="outlined"
            onClick={handleManageBilling}
            endIcon={<ExternalLink size={14} />}
          >
            Manage Billing
          </Button>
        )}
      </Box>

      {/* Period info */}
      {status.currentPeriodEnd && (
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ mt: 1, display: "block" }}
        >
          Current period ends{" "}
          {new Date(status.currentPeriodEnd).toLocaleDateString()}
        </Typography>
      )}
    </Box>
  );
}
