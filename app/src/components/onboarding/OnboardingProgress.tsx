import { Box, Stepper, Step, StepLabel, useTheme } from "@mui/material";

export type OnboardingStep = "qualification" | "path" | "database";

interface OnboardingProgressProps {
  currentStep: OnboardingStep;
}

const STEPS = [
  { key: "qualification" as const, label: "About You" },
  { key: "path" as const, label: "Choose Path" },
  { key: "database" as const, label: "Setup" },
];

export function OnboardingProgress({ currentStep }: OnboardingProgressProps) {
  const theme = useTheme();
  const activeIndex = STEPS.findIndex(s => s.key === currentStep);

  return (
    <Box sx={{ width: "100%", mb: 4 }}>
      <Stepper
        activeStep={activeIndex}
        alternativeLabel
        sx={{
          "& .MuiStepLabel-label": {
            fontSize: "0.875rem",
            fontWeight: 500,
          },
          "& .MuiStepLabel-label.Mui-active": {
            color: theme.palette.primary.main,
            fontWeight: 600,
          },
          "& .MuiStepLabel-label.Mui-completed": {
            color: theme.palette.success.main,
          },
        }}
      >
        {STEPS.map(step => (
          <Step key={step.key}>
            <StepLabel>{step.label}</StepLabel>
          </Step>
        ))}
      </Stepper>
    </Box>
  );
}
