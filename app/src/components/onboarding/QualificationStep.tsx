import { useState, useEffect } from "react";
import {
  Box,
  Typography,
  FormControl,
  FormLabel,
  RadioGroup,
  FormControlLabel,
  Radio,
  Checkbox,
  FormGroup,
  Button,
  Stack,
} from "@mui/material";
import { ArrowForward as ArrowForwardIcon } from "@mui/icons-material";
import {
  QualificationData,
  CompanySize,
  ROLE_OPTIONS,
  COMPANY_SIZE_OPTIONS,
  DATABASE_TYPE_OPTIONS,
} from "./types";

interface QualificationStepProps {
  initialData?: QualificationData;
  onComplete: (data: QualificationData) => void;
}

export function QualificationStep({
  initialData,
  onComplete,
}: QualificationStepProps) {
  const [role, setRole] = useState<string>(initialData?.role || "");
  const [companySize, setCompanySize] = useState<CompanySize | "">(
    initialData?.companySize || "",
  );
  const [databaseTypes, setDatabaseTypes] = useState<string[]>(
    initialData?.databaseTypes || [],
  );

  // Auto-advance when all questions are answered
  const isComplete = role && companySize && databaseTypes.length > 0;

  const handleDatabaseTypeChange = (value: string, checked: boolean) => {
    if (value === "none") {
      // If "I don't have a database" is selected, clear other selections
      if (checked) {
        setDatabaseTypes(["none"]);
      } else {
        setDatabaseTypes([]);
      }
    } else {
      // Remove "none" if selecting a database type
      setDatabaseTypes(prev => {
        const filtered = prev.filter(v => v !== "none");
        if (checked) {
          return [...filtered, value];
        } else {
          return filtered.filter(v => v !== value);
        }
      });
    }
  };

  const handleContinue = () => {
    if (!isComplete) return;

    const hasNoDatabase = databaseTypes.includes("none");
    const dbTypes = databaseTypes.filter(t => t !== "none");

    onComplete({
      role,
      companySize: companySize as CompanySize,
      databaseTypes: dbTypes,
      hasNoDatabase,
    });
  };

  return (
    <Box>
      <Typography variant="h5" gutterBottom sx={{ mb: 3 }}>
        Tell us about yourself
      </Typography>
      <Typography color="text.secondary" sx={{ mb: 4 }}>
        Help us personalize your experience with a few quick questions.
      </Typography>

      <Stack spacing={4}>
        {/* Question 1: Role */}
        <FormControl component="fieldset">
          <FormLabel component="legend" sx={{ mb: 1, fontWeight: 500 }}>
            What's your role?
          </FormLabel>
          <RadioGroup
            value={role}
            onChange={e => setRole(e.target.value)}
          >
            {ROLE_OPTIONS.map(option => (
              <FormControlLabel
                key={option.value}
                value={option.value}
                control={<Radio size="small" />}
                label={option.label}
              />
            ))}
          </RadioGroup>
        </FormControl>

        {/* Question 2: Company Size */}
        <FormControl component="fieldset">
          <FormLabel component="legend" sx={{ mb: 1, fontWeight: 500 }}>
            Company size
          </FormLabel>
          <RadioGroup
            value={companySize}
            onChange={e => setCompanySize(e.target.value as CompanySize)}
          >
            {COMPANY_SIZE_OPTIONS.map(option => (
              <FormControlLabel
                key={option.value}
                value={option.value}
                control={<Radio size="small" />}
                label={option.label}
              />
            ))}
          </RadioGroup>
        </FormControl>

        {/* Question 3: Database Types */}
        <FormControl component="fieldset">
          <FormLabel component="legend" sx={{ mb: 1, fontWeight: 500 }}>
            What databases do you work with?
          </FormLabel>
          <Typography variant="caption" color="text.secondary" sx={{ mb: 1 }}>
            Select all that apply
          </Typography>
          <FormGroup>
            {DATABASE_TYPE_OPTIONS.map(option => (
              <FormControlLabel
                key={option.value}
                control={
                  <Checkbox
                    size="small"
                    checked={databaseTypes.includes(option.value)}
                    onChange={e =>
                      handleDatabaseTypeChange(option.value, e.target.checked)
                    }
                    disabled={
                      option.value !== "none" && databaseTypes.includes("none")
                    }
                  />
                }
                label={option.label}
                sx={{
                  ...(option.value === "none" && {
                    mt: 1,
                    borderTop: "1px solid",
                    borderColor: "divider",
                    pt: 1,
                  }),
                }}
              />
            ))}
          </FormGroup>
        </FormControl>

        {/* Continue Button */}
        <Button
          variant="contained"
          size="large"
          endIcon={<ArrowForwardIcon />}
          onClick={handleContinue}
          disabled={!isComplete}
          sx={{ mt: 2 }}
        >
          Continue
        </Button>
      </Stack>
    </Box>
  );
}
