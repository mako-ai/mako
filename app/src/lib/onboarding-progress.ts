/**
 * Per-tab onboarding progress (which step, the qualification answers), so a
 * reload mid-onboarding resumes where the user was instead of restarting the
 * questionnaire. sessionStorage: it is a draft of this tab's flow, not
 * account state, and must not leak into another tab or a later session.
 */
import type { QualificationData } from "../components/onboarding/QualificationStep";

const KEY = "mako.onboarding.progress";

export type OnboardingProgressStep = "qualification" | "path" | "database";

export interface OnboardingProgress {
  workspaceId: string;
  step: OnboardingProgressStep;
  qualificationData: QualificationData | null;
  /** Answers given so far inside the questionnaire (before it completes). */
  draft?: Partial<QualificationData>;
  questionIndex?: number;
}

export function readOnboardingProgress(
  workspaceId: string,
): OnboardingProgress | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as OnboardingProgress;
    return parsed && parsed.workspaceId === workspaceId ? parsed : null;
  } catch {
    return null;
  }
}

export function writeOnboardingProgress(progress: OnboardingProgress): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(progress));
  } catch {
    // Storage unavailable: a reload just restarts the questionnaire.
  }
}

export function updateOnboardingProgress(
  workspaceId: string,
  patch: Partial<Omit<OnboardingProgress, "workspaceId">>,
): void {
  const current = readOnboardingProgress(workspaceId) ?? {
    workspaceId,
    step: "qualification" as const,
    qualificationData: null,
  };
  writeOnboardingProgress({ ...current, ...patch, workspaceId });
}

export function clearOnboardingProgress(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}
