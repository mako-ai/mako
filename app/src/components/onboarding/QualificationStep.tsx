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
  primaryDatabase: string; // "none" if user has no database
  dataWarehouse: string;
}

interface QualificationStepProps {
  initialData?: Partial<QualificationData>;
  /** Question to open on (resuming after a reload). */
  initialQuestionIndex?: number;
  /** Called as answers change, so the flow can survive a reload. */
  onProgress?: (
    draft: Partial<QualificationData>,
    questionIndex: number,
  ) => void;
  onComplete: (data: QualificationData) => void;
}

/**
 * Arrow-key navigation for a radiogroup of option cards (WAI-ARIA radio
 * pattern): moving focus also selects, like native radios.
 */
function handleRadioGroupKeyDown(event: React.KeyboardEvent<HTMLElement>) {
  const forward = event.key === "ArrowDown" || event.key === "ArrowRight";
  const backward = event.key === "ArrowUp" || event.key === "ArrowLeft";
  if (!forward && !backward) return;
  // Arrow keys inside the "Other" text field move the caret, not the radio.
  if (event.target instanceof HTMLInputElement) return;
  const radios = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]'),
  );
  if (radios.length === 0) return;
  const current = radios.findIndex(
    radio =>
      radio === document.activeElement ||
      radio.contains(document.activeElement),
  );
  const nextIndex =
    current === -1
      ? 0
      : (current + (forward ? 1 : -1) + radios.length) % radios.length;
  event.preventDefault();
  const next = radios[nextIndex];
  next.focus();
  next.click();
}

/** Space/Enter select a focused option card. */
function handleRadioKeyDown(
  event: React.KeyboardEvent<HTMLElement>,
  select: () => void,
) {
  if (event.target !== event.currentTarget) return;
  if (event.key === " " || event.key === "Enter") {
    event.preventDefault();
    select();
  }
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

/**
 * One option card. Module-level (not defined inside QualificationStep) so it
 * keeps its identity across renders: a component recreated every render
 * remounts, which dropped keyboard focus on each selection.
 */
const OptionButton = ({
  selected,
  label,
  onClick,
  tabbable,
}: {
  selected: boolean;
  label: string;
  onClick: () => void;
  /** Roving tabindex: only the checked (or first) option is tabbable. */
  tabbable: boolean;
}) => (
  <Paper
    onClick={onClick}
    role="radio"
    aria-checked={selected}
    tabIndex={tabbable ? 0 : -1}
    onKeyDown={event => handleRadioKeyDown(event, onClick)}
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
      "&:focus-visible": {
        outline: "2px solid",
        outlineColor: "primary.main",
        outlineOffset: 2,
      },
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
      color={selected ? "primary.main" : "text.primary"}
      sx={{
        fontWeight: selected ? 600 : 400,
      }}
    >
      {label}
    </Typography>
  </Paper>
);

export function QualificationStep({
  initialData,
  initialQuestionIndex,
  onProgress,
  onComplete,
}: QualificationStepProps) {
  const theme = useTheme();
  const [questionIndex, setQuestionIndex] = useState(() =>
    Math.min(Math.max(initialQuestionIndex ?? 0, 0), TOTAL_QUESTIONS - 1),
  );
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

  const onProgressRef = useRef(onProgress);
  onProgressRef.current = onProgress;
  useEffect(() => {
    onProgressRef.current?.(
      {
        role,
        companySize: (companySize || undefined) as
          QualificationData["companySize"] | undefined,
        primaryDatabase,
        dataWarehouse,
      },
      questionIndex,
    );
  }, [questionIndex, role, companySize, primaryDatabase, dataWarehouse]);

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
          dataWarehouse: "none",
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

  // Other option that transforms into an input when selected
  // Called as a function, not rendered as a JSX element: it closes
  // over this component, and a component recreated every render remounts
  // (the input lost focus on every keystroke).
  const renderOtherOption = ({
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
          role="radio"
          aria-checked
          aria-label="Other"
          tabIndex={-1}
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
            ref={otherInputRef as React.RefObject<HTMLInputElement | null>}
            type="text"
            aria-label={placeholder}
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
        role="radio"
        aria-checked={false}
        tabIndex={-1}
        onKeyDown={event => handleRadioKeyDown(event, onSelect)}
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
          "&:focus-visible": {
            outline: "2px solid",
            outlineColor: "primary.main",
            outlineOffset: 2,
          },
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
        <Typography
          variant="body1"
          sx={{
            color: "text.primary",
          }}
        >
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

  const questionTitleId = `onboarding-question-${questionIndex}`;
  const radioGroupProps = {
    role: "radiogroup",
    "aria-labelledby": questionTitleId,
    onKeyDown: handleRadioGroupKeyDown,
    sx: { display: "flex", flexDirection: "column", gap: 1.5 },
  } as const;

  // Render current question content
  const renderQuestionContent = () => {
    switch (questionIndex) {
      case 0:
        return (
          <Box {...radioGroupProps}>
            {ROLES.filter(r => r.value !== "other").map((r, index) => (
              <OptionButton
                key={r.value}
                tabbable={role ? role === r.value : index === 0}
                selected={role === r.value}
                label={r.label}
                onClick={() => setRole(r.value)}
              />
            ))}
            {renderOtherOption({
              selected: role === "other",
              value: roleOther,
              onChange: setRoleOther,
              onSelect: () => setRole("other"),
              placeholder: "Please specify your role...",
            })}
          </Box>
        );

      case 1:
        return (
          <Box {...radioGroupProps}>
            {COMPANY_SIZES.map((s, index) => (
              <OptionButton
                key={s.value}
                tabbable={companySize ? companySize === s.value : index === 0}
                selected={companySize === s.value}
                label={s.label}
                onClick={() => setCompanySize(s.value)}
              />
            ))}
          </Box>
        );

      case 2:
        return (
          <Box {...radioGroupProps}>
            {PRIMARY_DATABASES.filter(db => db.value !== "other").map(
              (db, index) => (
                <OptionButton
                  key={db.value}
                  tabbable={
                    primaryDatabase ? primaryDatabase === db.value : index === 0
                  }
                  selected={primaryDatabase === db.value}
                  label={db.label}
                  onClick={() => setPrimaryDatabase(db.value)}
                />
              ),
            )}
            {renderOtherOption({
              selected: primaryDatabase === "other",
              value: databaseOther,
              onChange: setDatabaseOther,
              onSelect: () => setPrimaryDatabase("other"),
              placeholder: "Please specify your database...",
            })}
          </Box>
        );

      case 3:
        return (
          <Box {...radioGroupProps}>
            {DATA_WAREHOUSES.filter(wh => wh.value !== "other").map(
              (wh, index) => (
                <OptionButton
                  key={wh.value}
                  tabbable={
                    dataWarehouse ? dataWarehouse === wh.value : index === 0
                  }
                  selected={dataWarehouse === wh.value}
                  label={wh.label}
                  onClick={() => setDataWarehouse(wh.value)}
                />
              ),
            )}
            {renderOtherOption({
              selected: dataWarehouse === "other",
              value: warehouseOther,
              onChange: setWarehouseOther,
              onSelect: () => setDataWarehouse("other"),
              placeholder: "Please specify your data warehouse...",
            })}
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
            aria-label="Previous question"
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
          <Typography
            id={questionTitleId}
            variant="h4"
            gutterBottom
            sx={{
              fontWeight: 600,
            }}
          >
            {getQuestionTitle()}
          </Typography>
          <Typography
            variant="body2"
            sx={{
              color: "text.secondary",
              mb: 3,
            }}
          >
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
