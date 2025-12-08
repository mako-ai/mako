/**
 * Email service using SendGrid for transactional emails
 */

interface SendGridMailData {
  to: string;
  from: string;
  subject: string;
  templateId?: string;
  dynamicTemplateData?: Record<string, any>;
  text?: string;
  html?: string;
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
  invitationTemplateId?: string;
  verificationTemplateId?: string;
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
    invitationTemplateId: process.env.SENDGRID_INVITATION_TEMPLATE_ID,
    verificationTemplateId: process.env.SENDGRID_VERIFICATION_TEMPLATE_ID,
  };
}

/**
 * Send email via SendGrid API
 */
async function sendMail(data: SendGridMailData): Promise<SendGridResponse> {
  const config = getConfig();

  if (!config.apiKey) {
    // Log the email for development/testing
    console.log("📧 [Email Service - Dev Mode]");
    console.log("To:", data.to);
    console.log("From:", data.from);
    console.log("Subject:", data.subject);
    if (data.templateId) {
      console.log("Template ID:", data.templateId);
      console.log("Template Data:", JSON.stringify(data.dynamicTemplateData, null, 2));
    }
    if (data.text) {
      console.log("Text:", data.text);
    }
    return { statusCode: 200 };
  }

  const body: any = {
    personalizations: [
      {
        to: [{ email: data.to }],
        dynamic_template_data: data.dynamicTemplateData,
      },
    ],
    from: { email: data.from },
    subject: data.subject,
  };

  if (data.templateId) {
    body.template_id = data.templateId;
  } else {
    body.content = [];
    if (data.text) {
      body.content.push({ type: "text/plain", value: data.text });
    }
    if (data.html) {
      body.content.push({ type: "text/html", value: data.html });
    }
  }

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

    if (config.invitationTemplateId) {
      // Use SendGrid dynamic template
      await sendMail({
        to,
        from: config.fromEmail,
        subject: `You've been invited to join ${workspaceName}`,
        templateId: config.invitationTemplateId,
        dynamicTemplateData: {
          workspace_name: workspaceName,
          inviter_name: inviterName,
          invite_url: inviteUrl,
          invitee_email: to,
        },
      });
    } else {
      // Use plain text/HTML fallback
      const subject = `You've been invited to join ${workspaceName}`;
      const text = `
Hello,

${inviterName} has invited you to join the workspace "${workspaceName}".

Click the link below to accept the invitation:
${inviteUrl}

This invitation will expire in 7 days.

If you didn't expect this invitation, you can safely ignore this email.
      `.trim();

      const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .button { display: inline-block; padding: 12px 24px; background-color: #1976d2; color: white; text-decoration: none; border-radius: 4px; margin: 20px 0; }
    .button:hover { background-color: #1565c0; }
    .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee; font-size: 12px; color: #666; }
  </style>
</head>
<body>
  <div class="container">
    <h2>You've been invited!</h2>
    <p><strong>${inviterName}</strong> has invited you to join the workspace <strong>"${workspaceName}"</strong>.</p>
    <a href="${inviteUrl}" class="button">Accept Invitation</a>
    <p>Or copy and paste this link into your browser:</p>
    <p style="word-break: break-all; color: #666;">${inviteUrl}</p>
    <div class="footer">
      <p>This invitation will expire in 7 days.</p>
      <p>If you didn't expect this invitation, you can safely ignore this email.</p>
    </div>
  </div>
</body>
</html>
      `.trim();

      await sendMail({
        to,
        from: config.fromEmail,
        subject,
        text,
        html,
      });
    }

    console.log(`✉️ Invitation email sent to ${to} for workspace ${workspaceName}`);
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

    if (config.verificationTemplateId) {
      // Use SendGrid dynamic template
      await sendMail({
        to,
        from: config.fromEmail,
        subject: "Verify your email address",
        templateId: config.verificationTemplateId,
        dynamicTemplateData: {
          verification_code: code,
          verify_url: verifyUrl,
          email: to,
        },
      });
    } else {
      // Use plain text/HTML fallback
      const subject = "Verify your email address";
      const text = `
Hello,

Your verification code is: ${code}

You can also click the link below to verify your email:
${verifyUrl}

This code will expire in 15 minutes.

If you didn't create an account, you can safely ignore this email.
      `.trim();

      const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .code { font-size: 32px; font-weight: bold; letter-spacing: 8px; background: #f5f5f5; padding: 20px; text-align: center; border-radius: 8px; margin: 20px 0; }
    .button { display: inline-block; padding: 12px 24px; background-color: #1976d2; color: white; text-decoration: none; border-radius: 4px; margin: 20px 0; }
    .button:hover { background-color: #1565c0; }
    .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee; font-size: 12px; color: #666; }
  </style>
</head>
<body>
  <div class="container">
    <h2>Verify your email address</h2>
    <p>Enter this code to verify your email:</p>
    <div class="code">${code}</div>
    <p>Or click the button below:</p>
    <a href="${verifyUrl}" class="button">Verify Email</a>
    <div class="footer">
      <p>This code will expire in 15 minutes.</p>
      <p>If you didn't create an account, you can safely ignore this email.</p>
    </div>
  </div>
</body>
</html>
      `.trim();

      await sendMail({
        to,
        from: config.fromEmail,
        subject,
        text,
        html,
      });
    }

    console.log(`✉️ Verification email sent to ${to}`);
  }

  /**
   * Send password reset email (for future use)
   */
  async sendPasswordResetEmail(to: string, resetUrl: string): Promise<void> {
    const config = getConfig();
    const subject = "Reset your password";

    const text = `
Hello,

We received a request to reset your password.

Click the link below to reset your password:
${resetUrl}

This link will expire in 1 hour.

If you didn't request a password reset, you can safely ignore this email.
    `.trim();

    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .button { display: inline-block; padding: 12px 24px; background-color: #1976d2; color: white; text-decoration: none; border-radius: 4px; margin: 20px 0; }
    .button:hover { background-color: #1565c0; }
    .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee; font-size: 12px; color: #666; }
  </style>
</head>
<body>
  <div class="container">
    <h2>Reset your password</h2>
    <p>We received a request to reset your password.</p>
    <a href="${resetUrl}" class="button">Reset Password</a>
    <p>Or copy and paste this link into your browser:</p>
    <p style="word-break: break-all; color: #666;">${resetUrl}</p>
    <div class="footer">
      <p>This link will expire in 1 hour.</p>
      <p>If you didn't request a password reset, you can safely ignore this email.</p>
    </div>
  </div>
</body>
</html>
    `.trim();

    await sendMail({
      to,
      from: config.fromEmail,
      subject,
      text,
      html,
    });

    console.log(`✉️ Password reset email sent to ${to}`);
  }
}

// Export singleton instance
export const emailService = new EmailService();
