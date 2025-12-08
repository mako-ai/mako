/**
 * Auth module exports
 */

export { sessionManager } from "./session";
export type {
  ValidatedSession,
  ValidatedUser,
  SessionAttributes,
  SessionCookie,
  CookieAttributes,
} from "./session";
export { getGoogle, getGitHub } from "./arctic";
export { AuthService } from "./auth.service";
export {
  authMiddleware,
  optionalAuthMiddleware,
  rateLimitMiddleware,
} from "./auth.middleware";
export { authRoutes } from "./auth.controller";
export {
  unifiedAuthMiddleware,
  isApiKeyAuth,
  isSessionAuth,
} from "./unified-auth.middleware";
