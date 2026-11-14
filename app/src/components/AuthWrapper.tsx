import { WorkspaceProvider } from "../contexts/workspace-context";
import { OnboardingProvider } from "../contexts/onboarding-context";
import { ProtectedRoute } from "./ProtectedRoute";

interface AuthWrapperProps {
  children: React.ReactNode;
}

/**
 * Wrapper component that provides workspace context and wraps children in
 * a protected route. Authentication comes from the single AuthProvider in
 * main.tsx: a second, nested provider here shadowed it (its own user state,
 * diverging on login/logout) and re-fetched /auth/me on every mount.
 *
 * Theme is provided once in main.tsx — do not nest another ThemeProvider here
 * or theme toggles will only update part of the tree until a full reload.
 */
export function AuthWrapper({ children }: AuthWrapperProps) {
  return (
    <OnboardingProvider>
      <WorkspaceProvider>
        <ProtectedRoute>{children}</ProtectedRoute>
      </WorkspaceProvider>
    </OnboardingProvider>
  );
}
