import { useState, FormEvent, useEffect, useRef, useCallback } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import {
  Box,
  Paper,
  TextField,
  Button,
  Typography,
  Alert,
  Link,
  CircularProgress,
} from "@mui/material";
import { Email as EmailIcon, CheckCircle } from "@mui/icons-material";
import { useAuth } from "../hooks/useAuth";
import {
  getAndClearInviteRedirect,
  hasInviteRedirect,
} from "../utils/invite-redirect";
import { trackEvent } from "../lib/analytics";

export function VerifyEmailPage() {
  const { verifyEmail, resendVerification, error, loading, clearError } =
    useAuth();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [resendSuccess, setResendSuccess] = useState(false);
  const [resendLoading, setResendLoading] = useState(false);
  const [verified, setVerified] = useState(false);

  // Track if auto-verification has been attempted to prevent duplicate calls
  // (React Strict Mode runs effects twice in development)
  const autoVerifyAttempted = useRef(false);

  const handleAutoVerify = useCallback(
    async (emailParam: string, codeParam: string) => {
      try {
        await verifyEmail(emailParam, codeParam);

        // Track email verification
        trackEvent("email_verified", { method: "link" });

        setVerified(true);
        // Redirect after short delay, checking for invite redirect first
        setTimeout(() => {
          const inviteRedirect = getAndClearInviteRedirect();
          if (inviteRedirect) {
            window.location.href = inviteRedirect;
          } else {
            navigate("/");
          }
        }, 2000);
      } catch (err) {
        // Error will be shown in UI
      }
    },
    [verifyEmail, navigate],
  );

  // Get email and code from URL params and auto-verify if present
  useEffect(() => {
    const emailParam = searchParams.get("email");
    const codeParam = searchParams.get("code");

    if (emailParam) {
      setEmail(emailParam);
    }

    if (codeParam) {
      setCode(codeParam);
    }

    // Auto-verify if both email and code are provided, but only once
    if (emailParam && codeParam && !autoVerifyAttempted.current) {
      autoVerifyAttempted.current = true;
      handleAutoVerify(emailParam, codeParam);
    }
  }, [searchParams, handleAutoVerify]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    clearError();
    setResendSuccess(false);

    if (!email || !code) {
      return;
    }

    try {
      await verifyEmail(email, code);

      // Track email verification
      trackEvent("email_verified", { method: "code" });

      setVerified(true);
      // Redirect after short delay, checking for invite redirect first
      setTimeout(() => {
        const inviteRedirect = getAndClearInviteRedirect();
        if (inviteRedirect) {
          window.location.href = inviteRedirect;
        } else {
          navigate("/");
        }
      }, 2000);
    } catch (err) {
      // Error displayed in UI
    }
  };

  const handleResend = async () => {
    if (!email) return;

    clearError();
    setResendSuccess(false);
    setResendLoading(true);

    try {
      await resendVerification(email);
      setResendSuccess(true);
    } catch (err) {
      // Error displayed in UI
    } finally {
      setResendLoading(false);
    }
  };

  // Verified state
  if (verified) {
    return (
      <Box
        sx={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          bgcolor: "background.default",
          p: 2,
        }}
      >
        <Paper
          elevation={3}
          sx={{
            p: 4,
            maxWidth: 400,
            width: "100%",
            borderRadius: 2,
            textAlign: "center",
          }}
        >
          <CheckCircle color="success" sx={{ fontSize: 60, mb: 2 }} />
          <Typography variant="h5" gutterBottom>
            Email Verified!
          </Typography>
          <Typography color="text.secondary" sx={{ mb: 2 }}>
            Your email has been verified successfully.
          </Typography>
          <Typography color="text.secondary">
            Redirecting you{hasInviteRedirect() ? " to the invitation" : ""}...
          </Typography>
        </Paper>
      </Box>
    );
  }

  return (
    <Box
      sx={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        bgcolor: "background.default",
        p: 2,
      }}
    >
      <Paper
        elevation={3}
        sx={{
          p: 4,
          maxWidth: 400,
          width: "100%",
          borderRadius: 2,
        }}
      >
        <Box sx={{ textAlign: "center", mb: 3 }}>
          <EmailIcon color="primary" sx={{ fontSize: 60, mb: 2 }} />
          <Typography variant="h4" component="h1" gutterBottom>
            Verify Your Email
          </Typography>
          <Typography variant="body2" color="text.secondary">
            We sent a verification code to{" "}
            <strong>{email || "your email"}</strong>. Enter the code below to
            verify your account.
          </Typography>
        </Box>

        {error && (
          <Alert severity="error" sx={{ mb: 2 }} onClose={clearError}>
            {error}
          </Alert>
        )}

        {resendSuccess && (
          <Alert severity="success" sx={{ mb: 2 }}>
            Verification code sent! Check your inbox.
          </Alert>
        )}

        <form onSubmit={handleSubmit}>
          <TextField
            fullWidth
            label="Email"
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            margin="normal"
            disabled={loading}
            autoComplete="email"
          />

          <TextField
            fullWidth
            label="Verification Code"
            value={code}
            onChange={e =>
              setCode(e.target.value.replace(/\D/g, "").slice(0, 6))
            }
            margin="normal"
            disabled={loading}
            autoComplete="one-time-code"
            placeholder="123456"
            inputProps={{
              maxLength: 6,
              style: { letterSpacing: "0.5em", textAlign: "center" },
            }}
            autoFocus
          />

          <Button
            type="submit"
            fullWidth
            variant="contained"
            size="large"
            disabled={loading || !email || code.length !== 6}
            sx={{ mt: 3, mb: 2 }}
          >
            {loading ? (
              <CircularProgress size={24} color="inherit" />
            ) : (
              "Verify Email"
            )}
          </Button>
        </form>

        <Box sx={{ textAlign: "center", mt: 2 }}>
          <Typography variant="body2" color="text.secondary">
            Didn't receive the code?{" "}
            <Link
              component="button"
              variant="body2"
              onClick={handleResend}
              disabled={resendLoading || !email}
            >
              {resendLoading ? "Sending..." : "Resend code"}
            </Link>
          </Typography>
        </Box>

        <Box sx={{ textAlign: "center", mt: 3 }}>
          <Link href="/login" variant="body2">
            Back to Login
          </Link>
        </Box>
      </Paper>
    </Box>
  );
}
