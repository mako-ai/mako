import type { ReactNode } from "react";
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Box,
  Typography,
} from "@mui/material";
import { styled } from "@mui/material/styles";
import {
  ErrorOutlined as ErrorOutlineIcon,
  ExpandMore as ExpandMoreIcon,
} from "@mui/icons-material";

const StepNumber = styled(Typography)(({ theme }) =>
  theme.unstable_sx({
    width: 20,
    height: 20,
    borderRadius: "50%",
    bgcolor: "primary.main",
    color: "primary.contrastText",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "0.75rem",
    fontWeight: "bold",
    flexShrink: 0,
  }),
);

const StepSummary = styled(AccordionSummary)(({ theme }) =>
  theme.unstable_sx({
    "& .MuiAccordionSummary-content": { alignItems: "center", gap: 1 },
  }),
);

export interface FlowStepDefinition {
  label: string;
  description: string;
}

interface FlowStepProps {
  index: number;
  step: FlowStepDefinition;
  expanded: boolean;
  onToggle: () => void;
  hasError?: boolean;
  children: ReactNode;
}

/**
 * One numbered, collapsible step of a flow form (Source, Destination, …).
 */
export function FlowStep({
  index,
  step,
  expanded,
  onToggle,
  hasError = false,
  children,
}: FlowStepProps) {
  return (
    <Accordion expanded={expanded} onChange={onToggle} sx={{ mb: 1 }}>
      <StepSummary expandIcon={<ExpandMoreIcon />}>
        <StepNumber>{index + 1}</StepNumber>
        {hasError && <ErrorOutlineIcon color="error" sx={{ fontSize: 16 }} />}
        <Box>
          <Typography variant="subtitle2">{step.label}</Typography>
          <Typography variant="caption" sx={{ color: "text.secondary" }}>
            {step.description}
          </Typography>
        </Box>
      </StepSummary>
      <AccordionDetails>{children}</AccordionDetails>
    </Accordion>
  );
}
