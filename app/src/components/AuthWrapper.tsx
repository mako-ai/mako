import { AuthProvider } from "../contexts/auth-context";
import { WorkspaceProvider } from "../contexts/workspace-context";
import { OnboardingProvider } from "../contexts/onboarding-context";
import { ProtectedRoute } from "./ProtectedRoute";

interface AuthWrapperProps {
  children: React.ReactNode;
}

/**
 * Wrapper component that provides authentication and workspace context
 * Also wraps children in protected route
 *
 * Theme is provided once in main.tsx — do not nest another ThemeProvider here
 * or theme toggles will only update part of the tree until a full reload.
 */
export function AuthWrapper({ children }: AuthWrapperProps) {
  return (
    <AuthProvider>
      <OnboardingProvider>
        <WorkspaceProvider>
          <ProtectedRoute>{children}</ProtectedRoute>
        </WorkspaceProvider>
      </OnboardingProvider>
    </AuthProvider>
  );
}
