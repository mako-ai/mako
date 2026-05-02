import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Card,
  CardActions,
  CardContent,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControl,
  FormControlLabel,
  FormGroup,
  IconButton,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Switch,
  TextField,
  Typography,
} from "@mui/material";
import {
  Add as AddIcon,
  Close as CloseIcon,
  Delete as DeleteIcon,
  Edit as EditIcon,
  History as HistoryIcon,
  NotificationsActive as NotifyIcon,
  Science as TestIcon,
} from "@mui/icons-material";
import type {
  NotificationChannelTypeApi,
  NotificationDeliveryApi,
  NotificationResourceTypeApi,
  NotificationRuleApi,
  NotificationTriggerApi,
} from "../lib/api-types";
import {
  ruleSummary,
  useNotificationRuleStore,
} from "../store/notificationRuleStore";
import { useSlackIntegrationStore } from "../store/slackIntegrationStore";
import { getApiBasePath } from "../lib/api-base-path";

const SLACK_WEBHOOK_PENDING_KEY = "slack_webhook_oauth_pending";

export interface FlowRunNotificationsSectionProps {
  workspaceId: string;
  resourceType: NotificationResourceTypeApi;
  resourceId: string | undefined;
  /** From workspace.role — only owner/admin can mutate rules */
  workspaceRole: string;
  /** Compact layout for dialogs */
  compact?: boolean;
}

function resourceCacheKey(
  resourceType: NotificationResourceTypeApi,
  resourceId: string,
): string {
  return `${resourceType}:${resourceId}`;
}

function triggersLabel(triggers: NotificationTriggerApi[]): string {
  const parts: string[] = [];
  if (triggers.includes("success")) parts.push("Success");
  if (triggers.includes("failure")) parts.push("Failure");
  return parts.join(" · ");
}

function formatDeliveryWhen(d: NotificationDeliveryApi): string {
  const raw = d.completedAt ?? d.sentAt ?? d.createdAt;
  try {
    return new Date(raw).toLocaleString();
  } catch {
    return raw;
  }
}

function formatDeliveryLine(d: NotificationDeliveryApi): string {
  const when = formatDeliveryWhen(d);
  return `${when} · ${d.trigger} · ${d.channelType} · ${d.status}${
    d.lastError ? ` — ${d.lastError}` : ""
  }`;
}

function channelTitle(type: NotificationChannelTypeApi): string {
  switch (type) {
    case "email":
      return "Email notification";
    case "webhook":
      return "Webhook notification";
    case "slack":
      return "Slack notification";
    default:
      return "Notification";
  }
}

export function FlowRunNotificationsSection({
  workspaceId,
  resourceType,
  resourceId,
  workspaceRole,
  compact,
}: FlowRunNotificationsSectionProps) {
  const canManage = workspaceRole === "owner" || workspaceRole === "admin";
  const cacheKey = resourceId ? resourceCacheKey(resourceType, resourceId) : "";

  const rules = useNotificationRuleStore(s =>
    cacheKey ? s.rulesByKey[cacheKey] : undefined,
  );
  const fetchRules = useNotificationRuleStore(s => s.fetchRules);
  const fetchDeliveries = useNotificationRuleStore(s => s.fetchDeliveries);
  const createRule = useNotificationRuleStore(s => s.createRule);
  const updateRule = useNotificationRuleStore(s => s.updateRule);
  const deleteRule = useNotificationRuleStore(s => s.deleteRule);
  const testNotification = useNotificationRuleStore(s => s.testNotification);
  const fetchSlackConnection = useSlackIntegrationStore(s => s.fetchConnection);
  const fetchSlackChannels = useSlackIntegrationStore(s => s.fetchChannels);
  const slackConn = useSlackIntegrationStore(s =>
    s.connectionByWorkspace[workspaceId],
  );
  const slackChannelOptions = useSlackIntegrationStore(s =>
    s.channelsByWorkspace[workspaceId],
  );

  const [loadError, setLoadError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<NotificationRuleApi | null>(
    null,
  );
  const [secretBanner, setSecretBanner] = useState<string | null>(null);

  const [successChecked, setSuccessChecked] = useState(true);
  const [failureChecked, setFailureChecked] = useState(true);
  const [channelType, setChannelType] =
    useState<NotificationChannelTypeApi>("email");
  const [recipientsText, setRecipientsText] = useState("");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookSigningSecret, setWebhookSigningSecret] = useState("");
  const [rotateWebhookSecret, setRotateWebhookSecret] = useState(false);
  const [slackWebhookUrl, setSlackWebhookUrl] = useState("");
  const [slackLabel, setSlackLabel] = useState("");
  const [slackChannelSelectId, setSlackChannelSelectId] = useState("");
  const [slackUseWebhookManual, setSlackUseWebhookManual] = useState(false);
  const [slackChannelsLoading, setSlackChannelsLoading] = useState(false);

  const [deliveryLogOpen, setDeliveryLogOpen] = useState(false);
  const [deliveryLogItems, setDeliveryLogItems] = useState<
    NotificationDeliveryApi[]
  >([]);
  const [deliveryLogLoading, setDeliveryLogLoading] = useState(false);
  const [testDialogOpen, setTestDialogOpen] = useState(false);
  const [testRuleId, setTestRuleId] = useState<string | null>(null);
  const [testTrigger, setTestTrigger] =
    useState<NotificationTriggerApi>("success");
  const [busyRuleId, setBusyRuleId] = useState<string | null>(null);

  const resetDialogFields = useCallback(() => {
    setSuccessChecked(true);
    setFailureChecked(true);
    setChannelType("email");
    setRecipientsText("");
    setWebhookUrl("");
    setWebhookSigningSecret("");
    setRotateWebhookSecret(false);
    setSlackWebhookUrl("");
    setSlackLabel("");
    setSlackChannelSelectId("");
    setSlackUseWebhookManual(false);
    setSecretBanner(null);
  }, []);

  const openCreateDialog = () => {
    setEditingRule(null);
    resetDialogFields();
    setDialogOpen(true);
  };

  const openEditDialog = (rule: NotificationRuleApi) => {
    setEditingRule(rule);
    setSecretBanner(null);
    setSuccessChecked(rule.triggers.includes("success"));
    setFailureChecked(rule.triggers.includes("failure"));
    const ch = rule.channel;
    setChannelType(ch.type);
    if (ch.type === "email") {
      setRecipientsText(ch.recipients.join(", "));
    } else {
      setRecipientsText("");
    }
    setWebhookUrl("");
    setWebhookSigningSecret("");
    setRotateWebhookSecret(false);
    setSlackWebhookUrl("");
    if (ch.type === "slack") {
      if (ch.slackBotMode && ch.slackChannelId) {
        setSlackChannelSelectId(ch.slackChannelId);
        setSlackUseWebhookManual(false);
        setSlackLabel(ch.slackChannelName || "");
      } else {
        setSlackChannelSelectId("");
        setSlackUseWebhookManual(true);
        setSlackLabel(ch.displayLabel || "");
      }
    } else {
      setSlackLabel("");
      setSlackChannelSelectId("");
      setSlackUseWebhookManual(false);
    }
    setDialogOpen(true);
  };

  useEffect(() => {
    if (!workspaceId || !resourceId) return;
    let cancelled = false;
    setLoadError(null);
    void (async () => {
      try {
        await fetchRules(workspaceId, resourceType, resourceId);
      } catch (e) {
        if (!cancelled) {
          setLoadError(
            e instanceof Error ? e.message : "Failed to load notifications",
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId, resourceId, resourceType, fetchRules]);

  useEffect(() => {
    if (!dialogOpen || channelType !== "slack" || !workspaceId || !canManage) {
      return;
    }
    void (async () => {
      await fetchSlackConnection(workspaceId);
    })();
  }, [
    dialogOpen,
    channelType,
    workspaceId,
    canManage,
    fetchSlackConnection,
  ]);

  useEffect(() => {
    if (
      !dialogOpen ||
      channelType !== "slack" ||
      !workspaceId ||
      slackUseWebhookManual ||
      slackConn === undefined ||
      slackConn === null
    ) {
      return;
    }
    setSlackChannelsLoading(true);
    void (async () => {
      try {
        await fetchSlackChannels(workspaceId);
      } catch {
        // channels optional; user can still paste webhook
      } finally {
        setSlackChannelsLoading(false);
      }
    })();
  }, [
    dialogOpen,
    channelType,
    workspaceId,
    slackConn,
    slackUseWebhookManual,
    fetchSlackChannels,
  ]);

  useEffect(() => {
    if (!workspaceId) return;
    try {
      const raw = sessionStorage.getItem(SLACK_WEBHOOK_PENDING_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as {
        workspaceId?: string;
        slackWebhookUrl?: string;
        displayLabel?: string;
      };
      if (parsed.workspaceId !== workspaceId || !parsed.slackWebhookUrl) return;
      sessionStorage.removeItem(SLACK_WEBHOOK_PENDING_KEY);
      setChannelType("slack");
      setSlackUseWebhookManual(true);
      setSlackWebhookUrl(parsed.slackWebhookUrl);
      if (parsed.displayLabel) setSlackLabel(parsed.displayLabel);
    } catch {
      sessionStorage.removeItem(SLACK_WEBHOOK_PENDING_KEY);
    }
  }, [workspaceId]);

  const loadDeliveryLog = useCallback(async () => {
    if (!workspaceId || !resourceId) return;
    setDeliveryLogLoading(true);
    try {
      const list = await fetchDeliveries(
        workspaceId,
        resourceType,
        resourceId,
        { limit: 100, skipCache: true },
      );
      setDeliveryLogItems(list);
    } catch (e) {
      setLoadError(
        e instanceof Error ? e.message : "Failed to load delivery history",
      );
    } finally {
      setDeliveryLogLoading(false);
    }
  }, [workspaceId, resourceId, resourceType, fetchDeliveries]);

  const handleOpenDeliveryLog = useCallback(() => {
    setDeliveryLogOpen(true);
    void loadDeliveryLog();
  }, [loadDeliveryLog]);

  const parsedRecipients = useMemo(() => {
    return recipientsText
      .split(/[\n,]+/)
      .map(s => s.trim())
      .filter(Boolean);
  }, [recipientsText]);

  const buildPayloadBase = (): Record<string, unknown> | null => {
    const triggers: NotificationTriggerApi[] = [];
    if (successChecked) triggers.push("success");
    if (failureChecked) triggers.push("failure");
    if (triggers.length === 0) return null;

    const base: Record<string, unknown> = {
      triggers,
      channelType,
    };

    if (channelType === "email") {
      if (parsedRecipients.length === 0) return null;
      base.recipients = parsedRecipients;
    } else if (channelType === "webhook") {
      if (editingRule && webhookUrl.trim() === "") {
        // keep URL server-side
      } else if (!webhookUrl.trim()) {
        return null;
      } else {
        base.url = webhookUrl.trim();
      }
      if (webhookSigningSecret.trim()) {
        base.signingSecret = webhookSigningSecret.trim();
      }
      if (editingRule?.channel.type === "webhook" && rotateWebhookSecret) {
        base.rotateWebhookSecret = true;
      }
    } else if (channelType === "slack") {
      const wsConnected = slackConn !== undefined && slackConn !== null;
      if (wsConnected && !slackUseWebhookManual) {
        if (!slackChannelSelectId.trim()) return null;
        base.slackChannelId = slackChannelSelectId.trim();
        const opt = slackChannelOptions?.find(
          c => c.id === slackChannelSelectId.trim(),
        );
        const label =
          opt?.name?.startsWith("#") || opt?.isPrivate
            ? opt?.name || slackLabel.trim()
            : slackLabel.trim() || (opt ? `#${opt.name}` : "");
        if (label) base.slackChannelName = label;
      } else {
        if (editingRule && slackWebhookUrl.trim() === "") {
          // keep URL server-side (webhook mode)
        } else if (!slackWebhookUrl.trim()) {
          return null;
        } else {
          base.slackWebhookUrl = slackWebhookUrl.trim();
        }
        if (slackLabel.trim()) base.displayLabel = slackLabel.trim();
      }
    }

    return base;
  };

  const handleSaveDialog = async () => {
    if (!workspaceId || !resourceId || !canManage) return;
    const body = buildPayloadBase();
    if (!body) {
      setLoadError(
        "Choose at least one event (success or failure) and complete the channel fields.",
      );
      return;
    }

    try {
      if (editingRule) {
        const res = await updateRule(workspaceId, editingRule.id, body);
        if (res.signingSecretOnce) {
          setSecretBanner(
            `Signing secret (copy now; shown once): ${res.signingSecretOnce}`,
          );
        } else {
          setDialogOpen(false);
        }
      } else {
        const res = await createRule(workspaceId, {
          resourceType,
          resourceId,
          enabled: true,
          ...body,
        });
        if (res.signingSecretOnce) {
          setSecretBanner(
            `Signing secret (copy now; shown once): ${res.signingSecretOnce}`,
          );
        } else {
          setDialogOpen(false);
        }
      }
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to save rule");
    }
  };

  const handleToggleEnabled = async (
    rule: NotificationRuleApi,
    on: boolean,
  ) => {
    if (!workspaceId || !canManage) return;
    setBusyRuleId(rule.id);
    try {
      await updateRule(workspaceId, rule.id, { enabled: on });
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to update rule");
    } finally {
      setBusyRuleId(null);
    }
  };

  const handleDelete = async (ruleId: string) => {
    if (!workspaceId || !canManage) return;
    if (!confirm("Delete this notification?")) return;
    try {
      await deleteRule(workspaceId, ruleId);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to delete");
    }
  };

  const handleOpenTest = (ruleId: string) => {
    setTestRuleId(ruleId);
    setTestTrigger("success");
    setTestDialogOpen(true);
  };

  const handleSendTest = async () => {
    if (!workspaceId || !resourceId || !testRuleId) return;
    try {
      await testNotification(workspaceId, {
        ruleId: testRuleId,
        resourceType,
        resourceId,
        trigger: testTrigger,
      });
      setTestDialogOpen(false);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Test failed");
    }
  };

  if (!resourceId) {
    return (
      <Alert severity="info" sx={{ mt: compact ? 0 : 2 }}>
        {`Save this ${
          resourceType === "scheduled_query" ? "query" : "flow"
        } first to configure run notifications.`}
      </Alert>
    );
  }

  return (
    <Box sx={{ mt: compact ? 0 : 2 }}>
      <Stack
        direction="row"
        alignItems="center"
        justifyContent="space-between"
        sx={{ mb: 1 }}
        flexWrap="wrap"
        gap={1}
      >
        <Typography variant="subtitle2" color="text.secondary">
          Run notifications
        </Typography>
        <Stack
          direction="row"
          alignItems="center"
          spacing={0.5}
          flexWrap="wrap"
        >
          <Button
            size="small"
            variant="text"
            startIcon={<HistoryIcon fontSize="small" />}
            onClick={handleOpenDeliveryLog}
            disabled={!resourceId}
            sx={{ textTransform: "none" }}
          >
            View delivery log
          </Button>
          {canManage && (
            <Button
              size="small"
              startIcon={<AddIcon />}
              onClick={openCreateDialog}
            >
              Add notification
            </Button>
          )}
        </Stack>
      </Stack>

      {!canManage && (
        <Typography
          variant="caption"
          color="text.secondary"
          display="block"
          sx={{ mb: 1 }}
        >
          Only workspace admins can edit notifications.
        </Typography>
      )}

      {loadError && (
        <Alert
          severity="error"
          sx={{ mb: 1 }}
          onClose={() => setLoadError(null)}
        >
          {loadError}
        </Alert>
      )}

      <Stack spacing={1}>
        {(rules ?? []).length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            No notifications yet. Notify on success or failure via email,
            webhook, or Slack.
          </Typography>
        ) : (
          (rules ?? []).map(rule => (
            <Card key={rule.id} variant="outlined">
              <CardContent sx={{ py: 1.5, "&:last-child": { pb: 1.5 } }}>
                <Stack spacing={0.75}>
                  <Stack direction="row" alignItems="center" spacing={1}>
                    <NotifyIcon fontSize="small" color="action" />
                    <Typography variant="subtitle2">
                      {channelTitle(rule.channel.type)}
                    </Typography>
                    <Chip size="small" label={triggersLabel(rule.triggers)} />
                  </Stack>
                  <Typography variant="body2" color="text.secondary">
                    {ruleSummary(rule)}
                  </Typography>
                </Stack>
              </CardContent>
              <CardActions sx={{ justifyContent: "flex-end", pt: 0 }}>
                <FormControlLabel
                  control={
                    <Switch
                      size="small"
                      checked={rule.enabled}
                      disabled={!canManage || busyRuleId === rule.id}
                      onChange={(_, v) => void handleToggleEnabled(rule, v)}
                    />
                  }
                  label="On"
                  sx={{ mr: 1 }}
                />
                <IconButton
                  size="small"
                  aria-label="Test notification"
                  onClick={() => handleOpenTest(rule.id)}
                  disabled={!canManage}
                >
                  <TestIcon fontSize="small" />
                </IconButton>
                <IconButton
                  size="small"
                  aria-label="Edit"
                  onClick={() => openEditDialog(rule)}
                  disabled={!canManage}
                >
                  <EditIcon fontSize="small" />
                </IconButton>
                <IconButton
                  size="small"
                  aria-label="Delete"
                  onClick={() => void handleDelete(rule.id)}
                  disabled={!canManage}
                >
                  <DeleteIcon fontSize="small" />
                </IconButton>
              </CardActions>
            </Card>
          ))
        )}
      </Stack>

      <Dialog
        open={deliveryLogOpen}
        onClose={() => setDeliveryLogOpen(false)}
        fullWidth
        maxWidth="sm"
        scroll="paper"
        PaperProps={{
          sx: {
            maxHeight: "min(560px, 85vh)",
            display: "flex",
            flexDirection: "column",
          },
        }}
      >
        <DialogTitle
          sx={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 1,
            pr: 1,
          }}
        >
          <Typography component="span" variant="h6" fontWeight={600}>
            Delivery log
          </Typography>
          <IconButton
            size="small"
            aria-label="Close delivery log"
            onClick={() => setDeliveryLogOpen(false)}
          >
            <CloseIcon fontSize="small" />
          </IconButton>
        </DialogTitle>
        <DialogContent dividers sx={{ flex: 1, overflow: "auto", py: 2 }}>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Notification send attempts for this{" "}
            {resourceType === "flow" ? "flow" : "scheduled query"}, newest first
            (up to 100).
          </Typography>
          {deliveryLogLoading ? (
            <Typography variant="body2" color="text.secondary">
              Loading…
            </Typography>
          ) : deliveryLogItems.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              No deliveries yet. Entries appear after a run finishes and a
              notification is sent.
            </Typography>
          ) : (
            <Stack
              component="ul"
              spacing={1}
              sx={{
                m: 0,
                pl: 2,
                listStyleType: "disc",
                "& li": { display: "list-item", pl: 0.25 },
              }}
            >
              {deliveryLogItems.map(d => (
                <Typography
                  key={d.id}
                  component="li"
                  variant="body2"
                  color="text.secondary"
                  sx={{ wordBreak: "break-word" }}
                >
                  {formatDeliveryLine(d)}
                </Typography>
              ))}
            </Stack>
          )}
        </DialogContent>
        <DialogActions sx={{ px: 2, py: 1.5 }}>
          <Button
            onClick={() => void loadDeliveryLog()}
            disabled={deliveryLogLoading}
          >
            Refresh
          </Button>
          <Button variant="contained" onClick={() => setDeliveryLogOpen(false)}>
            Close
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>
          {editingRule ? "Edit notification" : "Add notification"}
        </DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            {secretBanner && (
              <Alert severity="warning" onClose={() => setSecretBanner(null)}>
                {secretBanner}
              </Alert>
            )}
            <Typography variant="subtitle2">When</Typography>
            <FormGroup>
              <FormControlLabel
                control={
                  <Checkbox
                    checked={successChecked}
                    onChange={e => setSuccessChecked(e.target.checked)}
                  />
                }
                label="Run succeeds"
              />
              <FormControlLabel
                control={
                  <Checkbox
                    checked={failureChecked}
                    onChange={e => setFailureChecked(e.target.checked)}
                  />
                }
                label="Run fails"
              />
            </FormGroup>
            <Divider />
            <Typography variant="subtitle2">Channel</Typography>
            <FormControl fullWidth size="small">
              <InputLabel>Type</InputLabel>
              <Select
                label="Type"
                value={channelType}
                onChange={e =>
                  setChannelType(e.target.value as NotificationChannelTypeApi)
                }
              >
                <MenuItem value="email">Email</MenuItem>
                <MenuItem value="webhook">Webhook</MenuItem>
                <MenuItem value="slack">Slack</MenuItem>
              </Select>
            </FormControl>

            {channelType === "email" && (
              <TextField
                label="Recipients"
                placeholder="comma or newline separated"
                fullWidth
                multiline
                minRows={2}
                value={recipientsText}
                onChange={e => setRecipientsText(e.target.value)}
              />
            )}

            {channelType === "webhook" && (
              <>
                <TextField
                  label="Webhook URL"
                  fullWidth
                  required={!editingRule}
                  placeholder={
                    editingRule?.channel.type === "webhook"
                      ? "Leave blank to keep current URL"
                      : undefined
                  }
                  value={webhookUrl}
                  onChange={e => setWebhookUrl(e.target.value)}
                />
                <TextField
                  label="Signing secret (optional)"
                  fullWidth
                  type="password"
                  autoComplete="new-password"
                  helperText={
                    editingRule?.channel.type === "webhook"
                      ? "Leave blank to keep the existing secret"
                      : "Leave blank to generate a secret automatically"
                  }
                  value={webhookSigningSecret}
                  onChange={e => setWebhookSigningSecret(e.target.value)}
                />
                {editingRule?.channel.type === "webhook" && (
                  <FormControlLabel
                    control={
                      <Checkbox
                        checked={rotateWebhookSecret}
                        onChange={e => setRotateWebhookSecret(e.target.checked)}
                      />
                    }
                    label="Rotate signing secret"
                  />
                )}
              </>
            )}

            {channelType === "slack" && (
              <>
                {canManage && slackConn === undefined && (
                  <Typography variant="caption" color="text.secondary">
                    Checking Slack workspace connection…
                  </Typography>
                )}
                {canManage &&
                  slackConn === null &&
                  !slackUseWebhookManual && (
                    <Stack spacing={1}>
                      <Typography variant="body2" color="text.secondary">
                        Connect Slack once to pick channels from a list, or add a
                        channel-only webhook (legacy).
                      </Typography>
                      <Stack direction="row" spacing={1} flexWrap="wrap">
                        <Button
                          size="small"
                          variant="contained"
                          onClick={() => {
                            if (!workspaceId) return;
                            const base = getApiBasePath(
                              import.meta.env.VITE_API_URL,
                            );
                            const returnTo = encodeURIComponent("/");
                            window.location.href = `${base}/workspaces/${workspaceId}/slack/install?installType=bot&returnTo=${returnTo}`;
                          }}
                        >
                          Connect Slack workspace
                        </Button>
                        <Button
                          size="small"
                          variant="outlined"
                          onClick={() => {
                            if (!workspaceId) return;
                            const base = getApiBasePath(
                              import.meta.env.VITE_API_URL,
                            );
                            const returnTo = encodeURIComponent("/");
                            window.location.href = `${base}/workspaces/${workspaceId}/slack/install?installType=webhook&returnTo=${returnTo}`;
                          }}
                        >
                          Add Slack channel (webhook)
                        </Button>
                      </Stack>
                      <Button
                        size="small"
                        onClick={() => setSlackUseWebhookManual(true)}
                      >
                        Paste webhook URL manually
                      </Button>
                    </Stack>
                  )}
                {canManage && slackConn != null && !slackUseWebhookManual && (
                  <Stack spacing={1}>
                    <FormControl fullWidth size="small" disabled={slackChannelsLoading}>
                      <InputLabel>Slack channel</InputLabel>
                      <Select
                        label="Slack channel"
                        value={slackChannelSelectId}
                        onChange={e => setSlackChannelSelectId(e.target.value)}
                      >
                        <MenuItem value="">
                          <em>Select a channel</em>
                        </MenuItem>
                        {(slackChannelOptions || []).map(ch => (
                          <MenuItem key={ch.id} value={ch.id}>
                            {ch.isPrivate ? "Private: " : "#"}
                            {ch.name}
                          </MenuItem>
                        ))}
                      </Select>
                    </FormControl>
                    <Typography variant="caption" color="text.secondary">
                      Invite the Mako app to private channels so it can post
                      there.
                    </Typography>
                    <Button
                      size="small"
                      onClick={() => {
                        setSlackUseWebhookManual(true);
                        setSlackChannelSelectId("");
                      }}
                    >
                      Use per-channel webhook instead
                    </Button>
                  </Stack>
                )}
                {slackUseWebhookManual && (
                  <>
                    <TextField
                      label="Slack incoming webhook URL"
                      fullWidth
                      required={!editingRule}
                      placeholder={
                        editingRule?.channel.type === "slack" &&
                        !editingRule.channel.slackBotMode
                          ? "Leave blank to keep current webhook"
                          : undefined
                      }
                      value={slackWebhookUrl}
                      onChange={e => setSlackWebhookUrl(e.target.value)}
                    />
                    <TextField
                      label="Label (optional)"
                      fullWidth
                      value={slackLabel}
                      onChange={e => setSlackLabel(e.target.value)}
                    />
                    {slackConn != null && (
                      <Button
                        size="small"
                        onClick={() => {
                          setSlackUseWebhookManual(false);
                          setSlackWebhookUrl("");
                        }}
                      >
                        Use workspace bot + channel list
                      </Button>
                    )}
                  </>
                )}
              </>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => {
              setDialogOpen(false);
              setSecretBanner(null);
            }}
          >
            {secretBanner ? "Done" : "Cancel"}
          </Button>
          {!secretBanner && (
            <Button variant="contained" onClick={() => void handleSaveDialog()}>
              Save
            </Button>
          )}
        </DialogActions>
      </Dialog>

      <Dialog
        open={testDialogOpen}
        onClose={() => setTestDialogOpen(false)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>Send test</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <Typography variant="body2" color="text.secondary">
              Sends a sample payload so you can verify the channel.
            </Typography>
            <FormControl fullWidth size="small">
              <InputLabel>Event</InputLabel>
              <Select
                label="Event"
                value={testTrigger}
                onChange={e =>
                  setTestTrigger(e.target.value as NotificationTriggerApi)
                }
              >
                <MenuItem value="success">Success</MenuItem>
                <MenuItem value="failure">Failure</MenuItem>
              </Select>
            </FormControl>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setTestDialogOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={() => void handleSendTest()}>
            Send test
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
