import { Box, Stepper, Step, StepLabel } from "@mui/material";

interface OnboardingProgressProps {
  currentStep: number;
  totalSteps: number;
  labels?: string[];
}

const DEFAULT_LABELS = ["About You", "Choose Path", "Get Started"];

export function OnboardingProgress({
  currentStep,
  totalSteps,
  labels = DEFAULT_LABELS,
}: OnboardingProgressProps) {
  return (
    <Box sx={{ width: "100%", mb: 4 }}>
      <Stepper activeStep={currentStep} alternativeLabel>
        {labels.slice(0, totalSteps).map((label, index) => (
          <Step key={index} completed={index < currentStep}>
            <StepLabel>{label}</StepLabel>
          </Step>
        ))}
      </Stepper>
    </Box>
  );
}
