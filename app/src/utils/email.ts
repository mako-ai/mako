/**
 * Email validation and normalization utilities
 */

/**
 * Simple email regex pattern
 * Validates: local@domain.tld
 * - Local part: letters, numbers, underscores, dots, hyphens, plus signs
 * - Domain: letters, numbers, hyphens (with dots for subdomains)
 * - TLD: at least 2 letters
 */
const EMAIL_REGEX =
  /^[a-zA-Z0-9._+-]+@[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)*\.[a-zA-Z]{2,}$/;

/**
 * Validate an email address against a simple regex pattern
 */
export function isValidEmail(email: string): boolean {
  if (!email || typeof email !== "string") {
    return false;
  }
  return EMAIL_REGEX.test(email.trim());
}

/**
 * Normalize an email address by trimming whitespace and converting to lowercase
 */
export function normalizeEmail(email: string): string {
  if (!email || typeof email !== "string") {
    return "";
  }
  return email.trim().toLowerCase();
}
