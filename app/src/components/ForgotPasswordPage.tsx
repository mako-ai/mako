import { useState, FormEvent } from "react";
import { Box, TextField, Button, Typography, Alert, Link } from "@mui/material";
import { authClient } from "../lib/auth-client";
import { AuthLayout } from "./AuthLayout";

interface ForgotPasswordPageProps {
  onBackToLogin: () => void;
}

export function ForgotPasswordPage({ onBackToLogin }: ForgotPasswordPageProps) {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});

  const validateForm = () => {
    const errors: Record<string, string> = {};

    if (!email) {
      errors.email = "Email is required";
    } else if (!/\S+@\S+\.\S+/.test(email)) {
      errors.email = "Please enter a valid email";
    }

    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!validateForm()) return;

    setLoading(true);
    try {
      await authClient.requestPasswordReset(email);
      setSuccess(true);
    } catch {
      // We show success even on error for security (don't reveal if email exists)
      setSuccess(true);
    } finally {
      setLoading(false);
    }
  };

  if (success) {
    return (
      <AuthLayout title="Check Your Email">
        <Typography variant="body2" sx={{ color: "text.secondary", mb: 4 }}>
          If an account exists with{" "}
          <Typography
            component="span"
            variant="body2"
            sx={{ fontWeight: "bold", color: "text.primary" }}
          >
            {email}
          </Typography>
          , you will receive a password reset link shortly.
        </Typography>
        <Typography variant="body2" sx={{ color: "text.secondary", mb: 4 }}>
          Please check your inbox and spam folder.
        </Typography>

        <Button
          fullWidth
          variant="contained"
          size="large"
          onClick={onBackToLogin}
          sx={{ py: 1.5 }}
        >
          Back to Login
        </Button>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Forgot Password"
      subtitle="Enter your email address and we'll send you a link to reset your password."
    >
      {error && (
        <Alert severity="error" sx={{ mb: 3 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      <form onSubmit={handleSubmit}>
        <Box sx={{ mb: 2.5 }}>
          <Typography
            variant="body2"
            sx={{ fontWeight: 500, mb: 1, color: "text.primary" }}
          >
            Email
          </Typography>
          <TextField
            fullWidth
            size="small"
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            error={!!formErrors.email}
            helperText={formErrors.email}
            disabled={loading}
            autoComplete="email"
            autoFocus
            placeholder="you@example.com"
          />
        </Box>

        <Button
          type="submit"
          fullWidth
          variant="contained"
          size="large"
          disabled={loading}
          sx={{ py: 1.5 }}
        >
          {loading ? "Sending..." : "Send Reset Link"}
        </Button>
      </form>

      <Box sx={{ textAlign: "center", mt: 4 }}>
        <Typography variant="body2" color="text.secondary">
          Remember your password?{" "}
          <Link
            component="button"
            variant="body2"
            onClick={e => {
              e.preventDefault();
              onBackToLogin();
            }}
            disabled={loading}
            sx={{ textDecoration: "none" }}
          >
            Back to login
          </Link>
        </Typography>
      </Box>
    </AuthLayout>
  );
}
