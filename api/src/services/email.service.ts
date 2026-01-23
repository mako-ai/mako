/**
 * Email service using SendGrid for transactional emails
 *
 * Security: All user-controlled data (workspace names, inviter names, etc.)
 * is passed to SendGrid dynamic templates which handle escaping.
 * We never interpolate user data into HTML strings directly.
 */

import { getLogger } from "../logging";

const logger = getLogger(["email"]);

interface SendGridMailData {
  to: string;
  from: string;
  subject: string;
  templateId: string;
  dynamicTemplateData: Record<string, any>;
}

interface SendGridResponse {
  statusCode: number;
  body?: any;
}

/**
 * Configuration for the email service
 */
interface EmailServiceConfig {
  apiKey: string;
  fromEmail: string;
  fromName: string;
  invitationTemplateId?: string;
  verificationTemplateId?: string;
  passwordResetTemplateId?: string;
}

/**
 * Get configuration from environment variables
 */
function getConfig(): EmailServiceConfig {
  const apiKey = process.env.SENDGRID_API_KEY;
  const fromEmail = process.env.SENDGRID_FROM_EMAIL;

  if (!apiKey) {
    logger.warn("SENDGRID_API_KEY not set - email sending will be disabled (logged only)");
  }

  return {
    apiKey: apiKey || "",
    fromEmail: fromEmail || "noreply@example.com",
    fromName: "Mako",
    invitationTemplateId: process.env.SENDGRID_INVITATION_TEMPLATE_ID,
    verificationTemplateId: process.env.SENDGRID_VERIFICATION_TEMPLATE_ID,
    passwordResetTemplateId: process.env.SENDGRID_PASSWORD_RESET_TEMPLATE_ID,
  };
}

/**
 * Log email for development mode (no API key configured)
 * Only logs safe metadata and plain text representations
 */
function logEmailForDev(
  type: string,
  to: string,
  subject: string,
  templateData: Record<string, any>,
): void {
  logger.info("Email Service - Dev Mode", {
    type,
    to,
    subject,
    templateData,
  });
}

/**
 * Send email via SendGrid API using dynamic templates only
 */
async function sendMail(data: SendGridMailData): Promise<SendGridResponse> {
  const config = getConfig();

  if (!config.apiKey) {
    // Dev mode - log only, no actual email sent
    return { statusCode: 200 };
  }

  const body = {
    personalizations: [
      {
        to: [{ email: data.to }],
        dynamic_template_data: data.dynamicTemplateData,
        subject: data.subject,
      },
    ],
    from: { email: data.from, name: config.fromName },
    template_id: data.templateId,
    subject: data.subject,
  };

  const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    logger.error("SendGrid error", { status: response.status, error: errorText });
    throw new Error(`Failed to send email: ${response.status}`);
  }

  return { statusCode: response.status };
}

/**
 * Email service class with methods for different email types
 *
 * All methods require SendGrid dynamic template IDs to be configured.
 * In dev mode (no API key), emails are logged but not sent.
 */
export class EmailService {
  /**
   * Send workspace invitation email
   */
  async sendInvitationEmail(
    to: string,
    workspaceName: string,
    inviterName: string,
    inviteUrl: string,
  ): Promise<void> {
    const config = getConfig();
    const templateData = {
      workspace_name: workspaceName,
      inviter_name: inviterName,
      invite_url: inviteUrl,
      invitee_email: to,
    };

    if (!config.apiKey) {
      logEmailForDev(
        "Invitation",
        to,
        `You've been invited to join ${workspaceName}`,
        templateData,
      );
      logger.info("Invitation email logged (dev mode)", { to, workspaceName });
      return;
    }

    if (!config.invitationTemplateId) {
      logger.error("SENDGRID_INVITATION_TEMPLATE_ID not configured - skipping invitation email");
      return;
    }

    await sendMail({
      to,
      from: config.fromEmail,
      subject: `You've been invited to join ${workspaceName}`,
      templateId: config.invitationTemplateId,
      dynamicTemplateData: templateData,
    });

    logger.info("Invitation email sent", { to, workspaceName });
  }

  /**
   * Send email verification code
   */
  async sendVerificationEmail(
    to: string,
    code: string,
    verifyUrl: string,
  ): Promise<void> {
    const config = getConfig();
    const templateData = {
      verification_code: code,
      verify_url: verifyUrl,
      email: to,
    };

    if (!config.apiKey) {
      logEmailForDev(
        "Verification",
        to,
        "Verify your email address",
        templateData,
      );
      logger.info("Verification email logged (dev mode)", { to });
      return;
    }

    if (!config.verificationTemplateId) {
      // This is a configuration error when SendGrid is enabled but template is missing
      // We must throw to prevent users from being created without receiving verification emails
      throw new Error(
        "Email configuration error: SENDGRID_VERIFICATION_TEMPLATE_ID is required when SENDGRID_API_KEY is set",
      );
    }

    await sendMail({
      to,
      from: config.fromEmail,
      subject: "Verify your email address",
      templateId: config.verificationTemplateId,
      dynamicTemplateData: templateData,
    });

    logger.info("Verification email sent", { to });
  }

  /**
   * Send password reset email
   */
  async sendPasswordResetEmail(to: string, resetUrl: string): Promise<void> {
    const config = getConfig();
    const templateData = {
      reset_url: resetUrl,
      email: to,
    };

    if (!config.apiKey) {
      logEmailForDev("Password Reset", to, "Reset your password", templateData);
      logger.info("Password reset email logged (dev mode)", { to });
      return;
    }

    if (!config.passwordResetTemplateId) {
      // This is a configuration error when SendGrid is enabled but template is missing
      // We must throw to prevent password reset from silently failing
      throw new Error(
        "Email configuration error: SENDGRID_PASSWORD_RESET_TEMPLATE_ID is required when SENDGRID_API_KEY is set",
      );
    }

    await sendMail({
      to,
      from: config.fromEmail,
      subject: "Reset your password",
      templateId: config.passwordResetTemplateId,
      dynamicTemplateData: templateData,
    });

    logger.info("Password reset email sent", { to });
  }
}

// Export singleton instance
export const emailService = new EmailService();
