import { useState } from "react";
import {
  Box,
  Typography,
  Button,
  FormControl,
  FormLabel,
  RadioGroup,
  FormControlLabel,
  Radio,
  Checkbox,
  FormGroup,
  Paper,
  Stack,
} from "@mui/material";
import ArrowForwardIcon from "@mui/icons-material/ArrowForward";

export interface QualificationData {
  role: string;
  companySize: "hobby" | "startup" | "growth" | "enterprise";
  databaseTypes: string[];
  hasNoDatabase: boolean;
}

interface QualificationStepProps {
  initialData?: Partial<QualificationData>;
  onComplete: (data: QualificationData) => void;
}

const ROLES = [
  { value: "developer", label: "Developer / Engineer" },
  { value: "data-analyst", label: "Data Analyst / Scientist" },
  { value: "founder", label: "Founder / Product Manager" },
  { value: "manager", label: "Engineering Manager / Team Lead" },
  { value: "other", label: "Other" },
];

const COMPANY_SIZES = [
  { value: "hobby", label: "Hobby / Personal project" },
  { value: "startup", label: "Startup (1-10 employees)" },
  { value: "growth", label: "Growth (11-100 employees)" },
  { value: "enterprise", label: "Enterprise (100+ employees)" },
];

const DATABASE_TYPES = [
  { value: "mongodb", label: "MongoDB" },
  { value: "postgresql", label: "PostgreSQL" },
  { value: "mysql", label: "MySQL" },
  { value: "bigquery", label: "BigQuery" },
  { value: "clickhouse", label: "ClickHouse" },
  { value: "other", label: "Other" },
];

export function QualificationStep({
  initialData,
  onComplete,
}: QualificationStepProps) {
  const [role, setRole] = useState(initialData?.role || "");
  const [companySize, setCompanySize] = useState<string>(
    initialData?.companySize || "",
  );
  const [databaseTypes, setDatabaseTypes] = useState<string[]>(
    initialData?.databaseTypes || [],
  );
  const [hasNoDatabase, setHasNoDatabase] = useState(
    initialData?.hasNoDatabase || false,
  );

  const handleDatabaseChange = (value: string, checked: boolean) => {
    if (checked) {
      setDatabaseTypes(prev => [...prev, value]);
      // If they select a database type, uncheck "I don't have a database"
      if (hasNoDatabase) {
        setHasNoDatabase(false);
      }
    } else {
      setDatabaseTypes(prev => prev.filter(t => t !== value));
    }
  };

  const handleNoDatabase = (checked: boolean) => {
    setHasNoDatabase(checked);
    // If they check "I don't have a database", clear the database types
    if (checked) {
      setDatabaseTypes([]);
    }
  };

  const isValid =
    role && companySize && (databaseTypes.length > 0 || hasNoDatabase);

  const handleContinue = () => {
    if (!isValid) return;

    onComplete({
      role,
      companySize: companySize as QualificationData["companySize"],
      databaseTypes,
      hasNoDatabase,
    });
  };

  return (
    <Box>
      <Typography variant="h5" fontWeight={600} gutterBottom>
        Tell us about yourself
      </Typography>
      <Typography color="text.secondary" sx={{ mb: 4 }}>
        Help us personalize your experience
      </Typography>

      <Stack spacing={4}>
        {/* Question 1: Role */}
        <Paper variant="outlined" sx={{ p: 3 }}>
          <FormControl component="fieldset" fullWidth>
            <FormLabel
              component="legend"
              sx={{ fontWeight: 600, mb: 2, color: "text.primary" }}
            >
              What&apos;s your role?
            </FormLabel>
            <RadioGroup
              value={role}
              onChange={e => setRole(e.target.value)}
              sx={{ gap: 0.5 }}
            >
              {ROLES.map(r => (
                <FormControlLabel
                  key={r.value}
                  value={r.value}
                  control={<Radio size="small" />}
                  label={r.label}
                  sx={{
                    m: 0,
                    py: 0.5,
                    px: 1,
                    borderRadius: 1,
                    "&:hover": { bgcolor: "action.hover" },
                  }}
                />
              ))}
            </RadioGroup>
          </FormControl>
        </Paper>

        {/* Question 2: Company Size */}
        <Paper variant="outlined" sx={{ p: 3 }}>
          <FormControl component="fieldset" fullWidth>
            <FormLabel
              component="legend"
              sx={{ fontWeight: 600, mb: 2, color: "text.primary" }}
            >
              Company size
            </FormLabel>
            <RadioGroup
              value={companySize}
              onChange={e => setCompanySize(e.target.value)}
              sx={{ gap: 0.5 }}
            >
              {COMPANY_SIZES.map(s => (
                <FormControlLabel
                  key={s.value}
                  value={s.value}
                  control={<Radio size="small" />}
                  label={s.label}
                  sx={{
                    m: 0,
                    py: 0.5,
                    px: 1,
                    borderRadius: 1,
                    "&:hover": { bgcolor: "action.hover" },
                  }}
                />
              ))}
            </RadioGroup>
          </FormControl>
        </Paper>

        {/* Question 3: Database Types */}
        <Paper variant="outlined" sx={{ p: 3 }}>
          <FormControl component="fieldset" fullWidth>
            <FormLabel
              component="legend"
              sx={{ fontWeight: 600, mb: 2, color: "text.primary" }}
            >
              What databases do you work with?
            </FormLabel>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Select all that apply
            </Typography>
            <FormGroup sx={{ gap: 0.5 }}>
              {DATABASE_TYPES.map(db => (
                <FormControlLabel
                  key={db.value}
                  control={
                    <Checkbox
                      size="small"
                      checked={databaseTypes.includes(db.value)}
                      onChange={e =>
                        handleDatabaseChange(db.value, e.target.checked)
                      }
                      disabled={hasNoDatabase}
                    />
                  }
                  label={db.label}
                  sx={{
                    m: 0,
                    py: 0.5,
                    px: 1,
                    borderRadius: 1,
                    "&:hover": { bgcolor: "action.hover" },
                    opacity: hasNoDatabase ? 0.5 : 1,
                  }}
                />
              ))}
              <Box sx={{ my: 1, borderTop: 1, borderColor: "divider" }} />
              <FormControlLabel
                control={
                  <Checkbox
                    size="small"
                    checked={hasNoDatabase}
                    onChange={e => handleNoDatabase(e.target.checked)}
                  />
                }
                label={
                  <Typography fontWeight={500}>
                    I don&apos;t have a database yet
                  </Typography>
                }
                sx={{
                  m: 0,
                  py: 0.5,
                  px: 1,
                  borderRadius: 1,
                  "&:hover": { bgcolor: "action.hover" },
                }}
              />
            </FormGroup>
          </FormControl>
        </Paper>

        <Button
          variant="contained"
          size="large"
          onClick={handleContinue}
          disabled={!isValid}
          endIcon={<ArrowForwardIcon />}
          sx={{ mt: 2, py: 1.5 }}
        >
          Continue
        </Button>
      </Stack>
    </Box>
  );
}
