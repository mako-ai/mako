import { Controller } from "react-hook-form";
import {
  Alert,
  Box,
  Button,
  Checkbox,
  FormControlLabel,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import {
  ContentCopy as CopyIcon,
  Webhook as WebhookIcon,
} from "@mui/icons-material";
import type { SyncFlowFormModel } from "./useSyncFlowForm";

export function SyncWebhookTrigger({ model }: { model: SyncFlowFormModel }) {
  const {
    webhookUrl,
    isSubmitting,
    isProvisioningWebhook,
    setPinTriggersOpen,
    webhookProvisionSucceeded,
    setWebhookProvisionSucceeded,
    isNewMode,
    control,
    watchDataSourceId,
    watchWebhookEnabled,
    watchWebhookSecret,
    connectorSupportsWebhook,
    provisioning,
    canProvisionWebhook,
    provisionProviderLabel,
    provisionErrorMessage,
    webhookSecretHelpText,
    isCdcCapableDest,
    handleProvisionWebhook,
  } = model;
  return (
    <>
      {/* Webhook trigger */}
      <Tooltip
        title={
          !watchDataSourceId
            ? "Select a source connection first"
            : connectorSupportsWebhook
              ? ""
              : "This connector does not provide webhooks — use a schedule"
        }
        placement="top-start"
      >
        <Box
          sx={{
            border: 1,
            borderColor: "divider",
            borderRadius: 1,
            p: 2,
            opacity: connectorSupportsWebhook ? 1 : 0.55,
          }}
        >
          <Controller
            name="webhookEnabled"
            control={control}
            render={({ field }) => (
              <FormControlLabel
                control={
                  <Checkbox
                    checked={Boolean(field.value)}
                    disabled={!connectorSupportsWebhook}
                    onChange={e => field.onChange(e.target.checked)}
                  />
                }
                label={
                  <Box>
                    <Typography variant="subtitle2">Webhooks</Typography>
                    <Typography
                      variant="caption"
                      sx={{
                        color: "text.secondary",
                      }}
                    >
                      Receive changes as they happen, on top of polling
                      {connectorSupportsWebhook
                        ? "."
                        : " (unavailable for this connector)."}
                    </Typography>
                  </Box>
                }
              />
            )}
          />

          {watchWebhookEnabled && (
            <Stack spacing={2} sx={{ mt: 1 }}>
              {!isCdcCapableDest && (
                <Alert severity="warning">
                  Webhook-triggered syncs require a CDC-capable destination
                  (BigQuery, PostgreSQL, ClickHouse, or MongoDB).
                </Alert>
              )}
              {isNewMode ? (
                <Alert severity="info" icon={<WebhookIcon />}>
                  {provisioning?.supported
                    ? `Create the sync below — we'll generate the webhook URL and create it in ${provisionProviderLabel} automatically.`
                    : "Create the sync below to generate the webhook URL, then paste the signing secret from your provider."}
                </Alert>
              ) : (
                <>
                  {isProvisioningWebhook && (
                    <Alert severity="info" icon={<WebhookIcon />}>
                      Creating webhook in {provisionProviderLabel}…
                    </Alert>
                  )}
                  {webhookProvisionSucceeded && !isProvisioningWebhook && (
                    <Alert
                      severity="success"
                      onClose={() => {
                        setWebhookProvisionSucceeded(false);
                        setPinTriggersOpen(false);
                      }}
                    >
                      Webhook created in {provisionProviderLabel}. URL and
                      signing secret are filled below — save if you change
                      anything.
                    </Alert>
                  )}
                  {provisionErrorMessage && (
                    <Alert severity="warning">
                      {provisionProviderLabel} refused the webhook subscription:{" "}
                      {provisionErrorMessage}. The sync keeps polling.
                    </Alert>
                  )}
                  {webhookUrl && (
                    <TextField
                      value={webhookUrl}
                      label="Webhook URL"
                      fullWidth
                      size="small"
                      slotProps={{
                        input: {
                          readOnly: true,
                          endAdornment: (
                            <Button
                              size="small"
                              onClick={() =>
                                navigator.clipboard.writeText(webhookUrl)
                              }
                            >
                              <CopyIcon fontSize="small" />
                            </Button>
                          ),
                        },
                      }}
                    />
                  )}
                  <Controller
                    name="webhookSecret"
                    control={control}
                    render={({ field }) => (
                      <TextField
                        {...field}
                        label="Webhook Secret"
                        placeholder="Enter webhook secret"
                        fullWidth
                        size="small"
                        helperText={webhookSecretHelpText}
                      />
                    )}
                  />
                  {canProvisionWebhook && (
                    <Box>
                      <Button
                        size="small"
                        variant="outlined"
                        onClick={handleProvisionWebhook}
                        disabled={isSubmitting || isProvisioningWebhook}
                      >
                        {isProvisioningWebhook
                          ? watchWebhookSecret
                            ? `Updating in ${provisionProviderLabel}...`
                            : `Creating in ${provisionProviderLabel}...`
                          : watchWebhookSecret || webhookProvisionSucceeded
                            ? `Update in ${provisionProviderLabel}`
                            : `Create in ${provisionProviderLabel}`}
                      </Button>
                    </Box>
                  )}
                </>
              )}
            </Stack>
          )}
        </Box>
      </Tooltip>
    </>
  );
}
