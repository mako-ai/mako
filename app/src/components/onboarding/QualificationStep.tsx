import { useState, useCallback, useRef, useEffect } from "react";
import {
  Box,
  Typography,
  Button,
  Paper,
  Fade,
  alpha,
  IconButton,
  useTheme,
} from "@mui/material";
import ArrowForwardIcon from "@mui/icons-material/ArrowForward";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import RadioButtonUncheckedIcon from "@mui/icons-material/RadioButtonUnchecked";

export interface QualificationData {
  role: string;
  companySize: "hobby" | "startup" | "growth" | "enterprise";
  primaryDatabase: string;
  dataWarehouse: string;
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

const PRIMARY_DATABASES = [
  { value: "postgresql", label: "PostgreSQL" },
  { value: "mysql", label: "MySQL" },
  { value: "sqlite", label: "SQLite" },
  { value: "other", label: "Other" },
  { value: "none", label: "I don't have one yet" },
];

const DATA_WAREHOUSES = [
  { value: "snowflake", label: "Snowflake" },
  { value: "bigquery", label: "BigQuery" },
  { value: "databricks", label: "Databricks" },
  { value: "other", label: "Other" },
  { value: "none", label: "I don't have one yet" },
];

const TOTAL_QUESTIONS = 4;

export function QualificationStep({
  initialData,
  onComplete,
}: QualificationStepProps) {
  const theme = useTheme();
  const [questionIndex, setQuestionIndex] = useState(0);
  const [role, setRole] = useState(initialData?.role || "");
  const [roleOther, setRoleOther] = useState("");
  const [companySize, setCompanySize] = useState<string>(
    initialData?.companySize || "",
  );
  const [primaryDatabase, setPrimaryDatabase] = useState<string>(
    initialData?.primaryDatabase || "",
  );
  const [databaseOther, setDatabaseOther] = useState("");
  const [dataWarehouse, setDataWarehouse] = useState<string>(
    initialData?.dataWarehouse || "",
  );
  const [warehouseOther, setWarehouseOther] = useState("");

  const otherInputRef = useRef<HTMLInputElement>(null);

  // Focus the "Other" input when it becomes visible
  useEffect(() => {
    if (
      (questionIndex === 0 && role === "other") ||
      (questionIndex === 2 && primaryDatabase === "other") ||
      (questionIndex === 3 && dataWarehouse === "other")
    ) {
      setTimeout(() => {
        otherInputRef.current?.focus();
      }, 100);
    }
  }, [questionIndex, role, primaryDatabase, dataWarehouse]);

  const isCurrentQuestionValid = useCallback(() => {
    switch (questionIndex) {
      case 0:
        return role === "other" ? !!roleOther.trim() : !!role;
      case 1:
        return !!companySize;
      case 2:
        return primaryDatabase === "other"
          ? !!databaseOther.trim()
          : !!primaryDatabase;
      case 3:
        return dataWarehouse === "other"
          ? !!warehouseOther.trim()
          : !!dataWarehouse;
      default:
        return false;
    }
  }, [
    questionIndex,
    role,
    roleOther,
    companySize,
    primaryDatabase,
    databaseOther,
    dataWarehouse,
    warehouseOther,
  ]);

  const getFinalValue = (
    value: string,
    otherValue: string,
    prefix: string = "",
  ) => {
    if (value === "other" && otherValue.trim()) {
      return `${prefix}other: ${otherValue.trim()}`;
    }
    return value;
  };

  const handleComplete = useCallback(() => {
    onComplete({
      role: getFinalValue(role, roleOther),
      companySize: companySize as QualificationData["companySize"],
      primaryDatabase: getFinalValue(primaryDatabase, databaseOther),
      dataWarehouse: getFinalValue(dataWarehouse, warehouseOther),
      hasNoDatabase: primaryDatabase === "none",
    });
  }, [
    role,
    roleOther,
    companySize,
    primaryDatabase,
    databaseOther,
    dataWarehouse,
    warehouseOther,
    onComplete,
  ]);

  const handleNext = useCallback(() => {
    if (!isCurrentQuestionValid()) return;

    if (questionIndex < TOTAL_QUESTIONS - 1) {
      // Skip warehouse question if user has no database
      if (questionIndex === 2 && primaryDatabase === "none") {
        onComplete({
          role: getFinalValue(role, roleOther),
          companySize: companySize as QualificationData["companySize"],
          primaryDatabase: "none",
          dataWarehouse: "",
          hasNoDatabase: true,
        });
      } else {
        setQuestionIndex(prev => prev + 1);
      }
    } else {
      handleComplete();
    }
  }, [
    questionIndex,
    isCurrentQuestionValid,
    handleComplete,
    primaryDatabase,
    role,
    roleOther,
    companySize,
    onComplete,
  ]);

  const handleBack = () => {
    if (questionIndex > 0) {
      setQuestionIndex(prev => prev - 1);
    }
  };

  const getQuestionTitle = () => {
    switch (questionIndex) {
      case 0:
        return "What's your role?";
      case 1:
        return "What's your company size?";
      case 2:
        return "What's your primary database?";
      case 3:
        return "Do you use a data warehouse?";
      default:
        return "";
    }
  };

  const getQuestionSubtitle = () => {
    switch (questionIndex) {
      case 0:
        return "This helps us tailor your experience";
      case 1:
        return "We'll customize features for your team";
      case 2:
        return "Select the database you use most";
      case 3:
        return "For analytics and reporting";
      default:
        return "";
    }
  };

  // Option button component
  const OptionButton = ({
    selected,
    label,
    onClick,
  }: {
    selected: boolean;
    label: string;
    onClick: () => void;
  }) => (
    <Paper
      onClick={onClick}
      elevation={0}
      sx={{
        p: 2,
        cursor: "pointer",
        border: 2,
        borderColor: selected ? "primary.main" : "divider",
        bgcolor: selected
          ? theme => alpha(theme.palette.primary.main, 0.04)
          : "background.paper",
        borderRadius: 2,
        transition: "all 0.15s ease",
        display: "flex",
        alignItems: "center",
        gap: 1.5,
        "&:hover": {
          borderColor: selected ? "primary.main" : "primary.light",
          bgcolor: selected
            ? theme => alpha(theme.palette.primary.main, 0.08)
            : theme => alpha(theme.palette.primary.main, 0.02),
          transform: "translateY(-1px)",
        },
      }}
    >
      {selected ? (
        <CheckCircleIcon sx={{ color: "primary.main", fontSize: 22 }} />
      ) : (
        <RadioButtonUncheckedIcon
          sx={{ color: "action.disabled", fontSize: 22 }}
        />
      )}
      <Typography
        variant="body1"
        fontWeight={selected ? 600 : 400}
        color={selected ? "primary.main" : "text.primary"}
      >
        {label}
      </Typography>
    </Paper>
  );

  // Other option that transforms into an input when selected
  const OtherOptionInput = ({
    selected,
    value,
    onChange,
    onSelect,
    placeholder,
  }: {
    selected: boolean;
    value: string;
    onChange: (v: string) => void;
    onSelect: () => void;
    placeholder: string;
  }) => {
    if (selected) {
      return (
        <Paper
          elevation={0}
          sx={{
            p: 2,
            border: 2,
            borderColor: "primary.main",
            bgcolor: theme => alpha(theme.palette.primary.main, 0.04),
            borderRadius: 2,
            display: "flex",
            alignItems: "center",
            gap: 1.5,
          }}
        >
          <CheckCircleIcon sx={{ color: "primary.main", fontSize: 22 }} />
          <input
            ref={otherInputRef as React.RefObject<HTMLInputElement>}
            type="text"
            placeholder={placeholder}
            value={value}
            onChange={e => onChange(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter" && isCurrentQuestionValid()) {
                handleNext();
              }
            }}
            autoFocus
            style={{
              flex: 1,
              border: "none",
              outline: "none",
              background: "transparent",
              fontSize: "1rem",
              fontWeight: 400,
              color: theme.palette.text.primary,
              fontFamily: "inherit",
            }}
          />
        </Paper>
      );
    }

    return (
      <Paper
        onClick={onSelect}
        elevation={0}
        sx={{
          p: 2,
          cursor: "pointer",
          border: 2,
          borderColor: "divider",
          bgcolor: "background.paper",
          borderRadius: 2,
          transition: "all 0.15s ease",
          display: "flex",
          alignItems: "center",
          gap: 1.5,
          "&:hover": {
            borderColor: "primary.light",
            bgcolor: theme => alpha(theme.palette.primary.main, 0.02),
            transform: "translateY(-1px)",
          },
        }}
      >
        <RadioButtonUncheckedIcon
          sx={{ color: "action.disabled", fontSize: 22 }}
        />
        <Typography variant="body1" color="text.primary">
          Other
        </Typography>
      </Paper>
    );
  };

  // Progress indicator
  const ProgressDots = () => (
    <Box sx={{ display: "flex", justifyContent: "center", gap: 1 }}>
      {Array.from({ length: TOTAL_QUESTIONS }).map((_, index) => (
        <Box
          key={index}
          sx={{
            width: index === questionIndex ? 24 : 8,
            height: 8,
            borderRadius: 4,
            bgcolor:
              index <= questionIndex ? "primary.main" : "action.disabled",
            transition: "all 0.3s ease",
          }}
        />
      ))}
    </Box>
  );

  // Render current question content
  const renderQuestionContent = () => {
    switch (questionIndex) {
      case 0:
        return (
          <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5 }}>
            {ROLES.filter(r => r.value !== "other").map(r => (
              <OptionButton
                key={r.value}
                selected={role === r.value}
                label={r.label}
                onClick={() => setRole(r.value)}
              />
            ))}
            <OtherOptionInput
              selected={role === "other"}
              value={roleOther}
              onChange={setRoleOther}
              onSelect={() => setRole("other")}
              placeholder="Please specify your role..."
            />
          </Box>
        );

      case 1:
        return (
          <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5 }}>
            {COMPANY_SIZES.map(s => (
              <OptionButton
                key={s.value}
                selected={companySize === s.value}
                label={s.label}
                onClick={() => setCompanySize(s.value)}
              />
            ))}
          </Box>
        );

      case 2:
        return (
          <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5 }}>
            {PRIMARY_DATABASES.filter(db => db.value !== "other").map(db => (
              <OptionButton
                key={db.value}
                selected={primaryDatabase === db.value}
                label={db.label}
                onClick={() => setPrimaryDatabase(db.value)}
              />
            ))}
            <OtherOptionInput
              selected={primaryDatabase === "other"}
              value={databaseOther}
              onChange={setDatabaseOther}
              onSelect={() => setPrimaryDatabase("other")}
              placeholder="Please specify your database..."
            />
          </Box>
        );

      case 3:
        return (
          <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5 }}>
            {DATA_WAREHOUSES.filter(wh => wh.value !== "other").map(wh => (
              <OptionButton
                key={wh.value}
                selected={dataWarehouse === wh.value}
                label={wh.label}
                onClick={() => setDataWarehouse(wh.value)}
              />
            ))}
            <OtherOptionInput
              selected={dataWarehouse === "other"}
              value={warehouseOther}
              onChange={setWarehouseOther}
              onSelect={() => setDataWarehouse("other")}
              placeholder="Please specify your data warehouse..."
            />
          </Box>
        );

      default:
        return null;
    }
  };

  return (
    <Box>
      {/* Back button - top left, subtle */}
      <Box sx={{ minHeight: 40, mb: 2 }}>
        {questionIndex > 0 && (
          <IconButton
            onClick={handleBack}
            size="small"
            sx={{
              color: "text.secondary",
              ml: -1,
              "&:hover": { bgcolor: "action.hover" },
            }}
          >
            <ArrowBackIcon fontSize="small" />
          </IconButton>
        )}
      </Box>

      {/* Question content */}
      <Fade in key={questionIndex} timeout={200}>
        <Box>
          {/* Question header */}
          <Typography variant="h4" fontWeight={600} gutterBottom>
            {getQuestionTitle()}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
            {getQuestionSubtitle()}
          </Typography>

          {renderQuestionContent()}
        </Box>
      </Fade>

      {/* Progress dots */}
      <Box sx={{ mt: 4, mb: 3 }}>
        <ProgressDots />
      </Box>

      {/* Next button - always visible, disabled until valid */}
      <Button
        variant="contained"
        size="large"
        fullWidth
        onClick={handleNext}
        disabled={!isCurrentQuestionValid()}
        endIcon={<ArrowForwardIcon />}
        sx={{ py: 1.5 }}
      >
        {questionIndex === TOTAL_QUESTIONS - 1 ? "Continue" : "Next"}
      </Button>
    </Box>
  );
}
