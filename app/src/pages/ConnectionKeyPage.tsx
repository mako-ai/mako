/**
 * The page a key link opens: `/connection-key/:workspaceId#<token>`.
 *
 * An agent created a source connection over MCP without its API key and gave
 * the user this link, so the key is pasted here instead of into the chat.
 * Signs the visitor in first; the link works once and expires. The agent
 * chose where the key is sent, so the page shows that and the person
 * confirms it before the key is saved.
 */
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Navigate, useLocation, useParams } from "react-router";
import {
  Alert,
  Box,
  Button,
  Checkbox,
  CircularProgress,
  FormControlLabel,
  Paper,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { CheckCircle2, KeyRound } from "lucide-react";
import { useAuth } from "../contexts/auth-context";
import { useConnectionKeyStore } from "../store/connectionKeyStore";
import { forgetKeyLinkToken, takeKeyLinkToken } from "../utils/key-link-token";

function Frame({ children }: { children: ReactNode }) {
  return (
    <Box
      sx={{
        minHeight: "100dvh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        p: 2,
        bgcolor: "background.default",
      }}
    >
      <Paper
        variant="outlined"
        sx={{ width: "100%", maxWidth: 440, p: { xs: 2.5, sm: 3.5 } }}
      >
        {children}
      </Paper>
    </Box>
  );
}

export default function ConnectionKeyPage() {
  const { workspaceId = "" } = useParams();
  const location = useLocation();
  const { user, loading: authLoading } = useAuth();
  // Read once, before anything renders: the fragment leaves the address bar.
  const [token] = useState(() => takeKeyLinkToken(workspaceId));
  const entry = useConnectionKeyStore(s => s.byToken[token]);
  const load = useConnectionKeyStore(s => s.load);
  const submit = useConnectionKeyStore(s => s.submit);
  const [values, setValues] = useState<Record<string, string>>({});
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    if (!user || !workspaceId || !token) return;
    void load(workspaceId, token);
  }, [user, workspaceId, token, load]);

  useEffect(() => {
    if (entry?.status === "saved") forgetKeyLinkToken(workspaceId);
  }, [entry?.status, workspaceId]);

  if (authLoading) {
    return (
      <Frame>
        <Box sx={{ display: "flex", justifyContent: "center" }}>
          <CircularProgress size={28} />
        </Box>
      </Frame>
    );
  }
  if (!user) {
    const returnTo = `${location.pathname}${location.search}`;
    return (
      <Navigate
        to={`/login?returnTo=${encodeURIComponent(returnTo)}`}
        replace
      />
    );
  }

  if (!token) {
    return (
      <Frame>
        <Stack spacing={2}>
          <Typography variant="h6">Key link unavailable</Typography>
          <Alert severity="warning">
            This link is incomplete. Open the full link your agent gave you.
          </Alert>
        </Stack>
      </Frame>
    );
  }

  if (!entry || entry.status === "loading") {
    return (
      <Frame>
        <Box sx={{ display: "flex", justifyContent: "center" }}>
          <CircularProgress size={28} />
        </Box>
      </Frame>
    );
  }

  if (entry.status === "error" || !entry.request) {
    return (
      <Frame>
        <Stack spacing={2}>
          <Typography variant="h6">Key link unavailable</Typography>
          <Alert severity="warning">{entry.error}</Alert>
          <Button href="/" variant="outlined">
            Open Mako
          </Button>
        </Stack>
      </Frame>
    );
  }

  const { request } = entry;

  if (entry.status === "saved") {
    return (
      <Frame>
        <Stack spacing={2} sx={{ alignItems: "flex-start" }}>
          <Box sx={{ color: "success.main", display: "flex" }}>
            <CheckCircle2 size={32} />
          </Box>
          <Typography variant="h6">Key saved</Typography>
          <Typography color="text.secondary">
            <strong>{request.name}</strong> is connected. You can close this tab
            and go back to your agent.
          </Typography>
          {entry.checkMessage && (
            <Typography variant="caption" color="text.secondary">
              Check: {entry.checkMessage}
            </Typography>
          )}
        </Stack>
      </Frame>
    );
  }

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void submit(workspaceId, token, values, confirmed);
  };
  const missing =
    request.fields.some(field => field.required && !values[field.name]) ||
    request.fields.every(field => !values[field.name]);
  const { destination } = request;

  return (
    <Frame>
      <form onSubmit={onSubmit} autoComplete="off">
        <Stack spacing={2.5}>
          <Stack direction="row" spacing={1.5} sx={{ alignItems: "center" }}>
            <Box sx={{ color: "primary.main", display: "flex" }}>
              <KeyRound size={24} />
            </Box>
            <Typography variant="h6">Add the key for {request.name}</Typography>
          </Stack>
          <Typography variant="body2" color="text.secondary">
            An agent created the <strong>{request.connector}</strong> connection{" "}
            <strong>{request.name}</strong>. Paste its key here: it is checked,
            stored encrypted, and never shown to the agent.
          </Typography>
          <Box
            sx={{
              border: 1,
              borderColor: "divider",
              borderRadius: 1,
              p: 1.5,
              bgcolor: "action.hover",
            }}
          >
            <Typography variant="subtitle2" gutterBottom>
              Where the key is sent
            </Typography>
            {destination.address ? (
              <Typography
                variant="body2"
                sx={{ fontFamily: "monospace", wordBreak: "break-all" }}
              >
                {destination.address}
              </Typography>
            ) : (
              <Typography variant="body2" color="text.secondary">
                The {request.connector} service.
              </Typography>
            )}
            {destination.settings.length > 0 && (
              <Box component="dl" sx={{ m: 0, mt: 1 }}>
                {destination.settings.map(setting => (
                  <Typography
                    key={setting.name}
                    variant="caption"
                    component="div"
                    color="text.secondary"
                    sx={{ wordBreak: "break-all" }}
                  >
                    {setting.label}: {setting.value}
                  </Typography>
                ))}
              </Box>
            )}
          </Box>
          {request.fields.map((field, index) => (
            <TextField
              key={field.name}
              label={field.label}
              type={field.type === "textarea" ? "text" : "password"}
              multiline={field.type === "textarea"}
              minRows={field.type === "textarea" ? 4 : undefined}
              required={field.required}
              autoFocus={index === 0}
              placeholder={field.placeholder}
              helperText={field.description}
              value={values[field.name] ?? ""}
              onChange={event =>
                setValues(current => ({
                  ...current,
                  [field.name]: event.target.value,
                }))
              }
              slotProps={{
                htmlInput: { autoComplete: "off", spellCheck: false },
              }}
              fullWidth
            />
          ))}
          <FormControlLabel
            control={
              <Checkbox
                checked={confirmed}
                onChange={event => setConfirmed(event.target.checked)}
              />
            }
            label={
              <Typography variant="body2">
                I checked where this key is sent, and I trust it.
              </Typography>
            }
          />
          {entry.submitError && (
            <Alert severity="error">{entry.submitError}</Alert>
          )}
          <Button
            type="submit"
            variant="contained"
            disabled={missing || !confirmed || entry.saving}
            startIcon={
              entry.saving ? <CircularProgress size={16} /> : undefined
            }
          >
            {entry.saving ? "Checking the key…" : "Save key"}
          </Button>
          <Typography variant="caption" color="text.secondary">
            This link works once and expires{" "}
            {new Date(request.expiresAt).toLocaleString()}.
          </Typography>
        </Stack>
      </form>
    </Frame>
  );
}
