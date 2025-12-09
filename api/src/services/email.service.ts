/**
 * Email service using SendGrid for transactional emails
 *
 * Security: All user-controlled data (workspace names, inviter names, etc.)
 * is passed to SendGrid dynamic templates which handle escaping.
 * We never interpolate user data into HTML strings directly.
 */

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
    console.warn(
      "SENDGRID_API_KEY not set - email sending will be disabled (logged only)",
    );
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
  console.log(`📧 [Email Service - Dev Mode] ${type}`);
  console.log("To:", to);
  console.log("Subject:", subject);
  console.log("Template Data:", JSON.stringify(templateData, null, 2));
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
    console.error("SendGrid error:", errorText);
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
      console.log(
        `✉️ [Dev] Invitation email logged for ${to} (workspace: ${workspaceName})`,
      );
      return;
    }

    if (!config.invitationTemplateId) {
      console.error(
        "SENDGRID_INVITATION_TEMPLATE_ID not configured - skipping invitation email",
      );
      return;
    }

    await sendMail({
      to,
      from: config.fromEmail,
      subject: `You've been invited to join ${workspaceName}`,
      templateId: config.invitationTemplateId,
      dynamicTemplateData: templateData,
    });

    console.log(
      `✉️ Invitation email sent to ${to} for workspace ${workspaceName}`,
    );
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
      console.log(`✉️ [Dev] Verification email logged for ${to}`);
      return;
    }

    if (!config.verificationTemplateId) {
      console.error(
        "SENDGRID_VERIFICATION_TEMPLATE_ID not configured - skipping verification email",
      );
      return;
    }

    await sendMail({
      to,
      from: config.fromEmail,
      subject: "Verify your email address",
      templateId: config.verificationTemplateId,
      dynamicTemplateData: templateData,
    });

    console.log(`✉️ Verification email sent to ${to}`);
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
      console.log(`✉️ [Dev] Password reset email logged for ${to}`);
      return;
    }

    if (!config.passwordResetTemplateId) {
      console.error(
        "SENDGRID_PASSWORD_RESET_TEMPLATE_ID not configured - skipping password reset email",
      );
      return;
    }

    await sendMail({
      to,
      from: config.fromEmail,
      subject: "Reset your password",
      templateId: config.passwordResetTemplateId,
      dynamicTemplateData: templateData,
    });

    console.log(`✉️ Password reset email sent to ${to}`);
  }
}

// Export singleton instance
export const emailService = new EmailService();
