import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Box,
  Button,
  Chip,
  InputBase,
  TextField,
  Typography,
} from "@mui/material";
import { keyframes } from "@mui/material/styles";
import {
  ChevronLeft,
  Circle,
  CircleDot,
  HelpCircle,
  PenLine,
  Square,
  SquareCheck,
} from "lucide-react";
import type {
  AskClarifyingQuestionsInput,
  AskClarifyingQuestionsOutput,
  ClarifyingQuestion,
} from "@mako/agent-tools";

interface ClarifyingQuestionsCardProps {
  input?: AskClarifyingQuestionsInput;
  /** Present once the tool has been resolved (read-only summary view). */
  output?: AskClarifyingQuestionsOutput;
  /** Required for the pending (interactive) card; unused for summaries. */
  onResolve?: (output: AskClarifyingQuestionsOutput) => void;
  /** Flat bottom edge so the card mates with the composer (pending dock). */
  docked?: boolean;
}

interface QuestionAnswer {
  /** Selected predefined options (single choice keeps at most one). */
  selected: string[];
  /** Whether the "Other" option is selected. */
  otherSelected: boolean;
  /** Free text for the "Other" option. */
  otherText: string;
  /** Free text for `type: "text"` questions. */
  text: string;
}

type AnswerMap = Record<string, QuestionAnswer>;

const emptyAnswer = (): QuestionAnswer => ({
  selected: [],
  otherSelected: false,
  otherText: "",
  text: "",
});

/**
 * Models sometimes include their own "Other" / "Something else" option even
 * though the form appends a free-text "Other…" row. Detect those so we can
 * collapse them into our row instead of showing "Other" twice.
 */
const isOtherLikeOption = (option: string): boolean =>
  /^(other|something else)[\s\W]*$/i.test(option.trim());

/** Predefined options with model-provided "Other"-style entries removed. */
const visibleOptions = (question: ClarifyingQuestion): string[] =>
  (question.options ?? []).filter(o => !isOtherLikeOption(o));

/** Whether to render the free-text "Other…" row for a choice question. */
const showsOtherRow = (question: ClarifyingQuestion): boolean =>
  question.allowOther !== false ||
  (question.options ?? []).some(isOtherLikeOption);

function buildResponse(
  question: ClarifyingQuestion,
  answer: QuestionAnswer,
): string | string[] {
  if (question.type === "text") return answer.text;

  const values = [...answer.selected];
  if (answer.otherSelected && answer.otherText.trim()) {
    values.push(answer.otherText.trim());
  }
  return question.allowMultiple ? values : (values[0] ?? "");
}

// Card slides up from behind the chat input, same as the prompt queue.
const cardSlideUp = keyframes`
  from { opacity: 0; transform: translateY(100%); }
  to { opacity: 1; transform: translateY(0); }
`;

// Per-question screen change: quick fade + slide-in from the right.
const stepFadeIn = keyframes`
  from { opacity: 0; transform: translateX(8px); }
  to { opacity: 1; transform: translateX(0); }
`;

const OPTION_ROW_SX = {
  display: "flex",
  alignItems: "center",
  gap: 1,
  px: 1,
  py: 0.5,
  minHeight: 32,
  borderRadius: 1,
  cursor: "pointer",
  userSelect: "none",
} as const;

interface OptionRowProps {
  label: string;
  selected: boolean;
  multiple: boolean;
  icon?: React.ReactNode;
  role?: "radio" | "checkbox";
  /** Show a subtle "Recommended" badge after the label. */
  recommended?: boolean;
  onToggle: () => void;
}

/** Single-line selectable option row (radio or checkbox semantics). */
const OptionRow: React.FC<OptionRowProps> = ({
  label,
  selected,
  multiple,
  icon,
  role,
  recommended,
  onToggle,
}) => {
  const indicator =
    icon ??
    (multiple ? (
      selected ? (
        <SquareCheck size={14} />
      ) : (
        <Square size={14} />
      )
    ) : selected ? (
      <CircleDot size={14} />
    ) : (
      <Circle size={14} />
    ));

  return (
    <Box
      role={role ?? (multiple ? "checkbox" : "radio")}
      aria-checked={selected}
      tabIndex={0}
      onClick={onToggle}
      onKeyDown={e => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onToggle();
        }
      }}
      sx={{
        ...OPTION_ROW_SX,
        backgroundColor: selected ? "action.selected" : "transparent",
        "&:hover": {
          backgroundColor: selected ? "action.selected" : "action.hover",
        },
      }}
    >
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          flexShrink: 0,
          color: selected ? "primary.main" : "text.secondary",
        }}
      >
        {indicator}
      </Box>
      <Typography sx={{ fontSize: 13, flex: 1, minWidth: 0 }}>
        {label}
      </Typography>
      {recommended && (
        <Chip
          size="small"
          label="Recommended"
          color="primary"
          variant="outlined"
          sx={{
            flexShrink: 0,
            height: 18,
            fontSize: 10,
            "& .MuiChip-label": { px: 0.75 },
          }}
        />
      )}
    </Box>
  );
};

/**
 * Cursor-style wizard for the deferred `ask_clarifying_questions` tool: one
 * question per screen, single-line option rows (radio/checkbox), an optional
 * "Other" free-text row, and Back / Skip / Next navigation. Resolves via
 * `onResolve` on submit or skip. With `output` present it renders a compact
 * read-only summary instead.
 */
export const ClarifyingQuestionsCard: React.FC<
  ClarifyingQuestionsCardProps
> = ({ input, output, onResolve, docked }) => {
  // ACP bridge input is unvalidated raw agent arguments — never trust the
  // shape. Keep only entries with the semantic minimum (string id + prompt)
  // and coerce options so nothing non-string reaches a React child.
  const questions = useMemo(() => {
    if (!Array.isArray(input?.questions)) return [];
    return input.questions
      .filter(
        (q): q is ClarifyingQuestion =>
          !!q &&
          typeof q === "object" &&
          typeof (q as { id?: unknown }).id === "string" &&
          typeof (q as { prompt?: unknown }).prompt === "string",
      )
      .map(q => ({
        ...q,
        options: Array.isArray(q.options)
          ? q.options.filter((o): o is string => typeof o === "string")
          : undefined,
      }));
  }, [input]);
  const [answers, setAnswers] = useState<AnswerMap>({});
  const [step, setStep] = useState(0);
  const advanceTimerRef = useRef<number | null>(null);
  const resolved = Boolean(output);

  const lastStep = Math.max(questions.length - 1, 0);
  const question = questions[Math.min(step, lastStep)];

  useEffect(
    () => () => {
      if (advanceTimerRef.current !== null) {
        window.clearTimeout(advanceTimerRef.current);
      }
    },
    [],
  );

  const getAnswer = (id: string): QuestionAnswer =>
    answers[id] ?? emptyAnswer();

  const updateAnswer = (id: string, patch: Partial<QuestionAnswer>) =>
    setAnswers(prev => ({
      ...prev,
      [id]: { ...(prev[id] ?? emptyAnswer()), ...patch },
    }));

  const cancelScheduledAdvance = () => {
    if (advanceTimerRef.current !== null) {
      window.clearTimeout(advanceTimerRef.current);
      advanceTimerRef.current = null;
    }
  };

  /** Brief delay so the selected state is visible before the screen changes. */
  const scheduleAdvance = () => {
    if (step >= lastStep) return;
    cancelScheduledAdvance();
    advanceTimerRef.current = window.setTimeout(() => {
      advanceTimerRef.current = null;
      setStep(prev => Math.min(prev + 1, lastStep));
    }, 150);
  };

  const toggleOption = (q: ClarifyingQuestion, option: string) => {
    const answer = getAnswer(q.id);
    if (q.allowMultiple) {
      updateAnswer(q.id, {
        selected: answer.selected.includes(option)
          ? answer.selected.filter(v => v !== option)
          : [...answer.selected, option],
      });
      return;
    }
    // Single choice: picking an option deselects "Other" and vice versa.
    const deselecting = answer.selected.includes(option);
    updateAnswer(q.id, {
      selected: deselecting ? [] : [option],
      otherSelected: false,
    });
    if (!deselecting) scheduleAdvance();
  };

  const toggleOther = (q: ClarifyingQuestion) => {
    const answer = getAnswer(q.id);
    cancelScheduledAdvance();
    updateAnswer(q.id, {
      otherSelected: !answer.otherSelected,
      ...(q.allowMultiple || answer.otherSelected ? {} : { selected: [] }),
    });
  };

  const handleSubmit = () => {
    if (resolved) return;
    onResolve?.({
      success: true,
      answers: questions.map(q => ({
        id: q.id,
        prompt: q.prompt,
        response: buildResponse(q, getAnswer(q.id)),
      })),
    });
  };

  const handleNext = () => {
    cancelScheduledAdvance();
    if (step < lastStep) {
      setStep(step + 1);
    } else {
      handleSubmit();
    }
  };

  const handleBack = () => {
    cancelScheduledAdvance();
    setStep(prev => Math.max(prev - 1, 0));
  };

  const handleSkip = () => {
    if (resolved) return;
    onResolve?.({ success: true, skipped: true });
  };

  /** Enter advances/submits from text fields (Shift+Enter inserts newline). */
  const handleTextKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleNext();
    }
  };

  const answer = question ? getAnswer(question.id) : emptyAnswer();
  const isLast = step >= lastStep;

  return (
    <Box
      sx={{
        border: 1,
        borderColor: "divider",
        borderRadius: 2.5,
        bgcolor: "background.paper",
        p: 0.5,
        ...(docked
          ? {
              borderBottom: 0,
              borderBottomLeftRadius: 0,
              borderBottomRightRadius: 0,
              transformOrigin: "bottom",
              animation: `${cardSlideUp} 220ms cubic-bezier(0.4, 0, 0.2, 1)`,
            }
          : { my: 0.5 }),
      }}
    >
      {/* Header — mirrors the queued-prompts "N Queued" header typography */}
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 0.5,
          px: 1,
          py: 0.5,
          color: "text.secondary",
        }}
      >
        <HelpCircle size={14} />
        <Typography
          variant="caption"
          sx={{ fontWeight: 600, letterSpacing: 0.2 }}
        >
          Clarifying questions
        </Typography>
        {resolved ? (
          <Chip
            size="small"
            label={output?.skipped ? "Skipped" : "Answered"}
            color={output?.skipped ? "default" : "success"}
            variant="outlined"
            sx={{ ml: "auto" }}
          />
        ) : (
          questions.length > 1 && (
            <Typography
              variant="caption"
              sx={{ ml: "auto", color: "text.secondary" }}
            >
              {step + 1} of {questions.length}
            </Typography>
          )
        )}
      </Box>

      {resolved ? (
        /* Read-only summary: compact queue-style rows */
        <Box>
          {questions.map(q => {
            const resolvedAnswer = output?.answers?.find(
              a => a.id === q.id,
            )?.response;
            const display = Array.isArray(resolvedAnswer)
              ? resolvedAnswer.join(", ") || "—"
              : resolvedAnswer || (output?.skipped ? "Skipped" : "—");

            return (
              <Box
                key={q.id}
                sx={{
                  display: "flex",
                  alignItems: "center",
                  gap: 1,
                  px: 1,
                  py: 0.5,
                  minHeight: 28,
                }}
              >
                <Box
                  sx={{
                    display: "flex",
                    alignItems: "center",
                    color: "text.secondary",
                    flexShrink: 0,
                  }}
                >
                  <Circle size={10} />
                </Box>
                <Typography sx={{ fontSize: 13, minWidth: 0 }}>
                  <Box component="span" sx={{ color: "text.secondary" }}>
                    {q.prompt}
                  </Box>
                  <Box component="span" sx={{ color: "text.secondary" }}>
                    {" — "}
                  </Box>
                  <Box component="span" sx={{ color: "text.primary" }}>
                    {display}
                  </Box>
                </Typography>
              </Box>
            );
          })}
        </Box>
      ) : (
        question && (
          <>
            {/* One question per screen, animated on step change */}
            <Box
              key={question.id}
              sx={{ animation: `${stepFadeIn} 150ms ease` }}
            >
              <Typography
                sx={{ fontSize: 13, fontWeight: 600, px: 1, pt: 0.5, pb: 0.75 }}
              >
                {question.prompt}
              </Typography>

              {question.type === "choice" ? (
                <Box
                  role={question.allowMultiple ? "group" : "radiogroup"}
                  aria-label={question.prompt}
                >
                  {question.allowMultiple && (
                    <Typography
                      variant="caption"
                      sx={{
                        display: "block",
                        px: 1,
                        pb: 0.5,
                        mt: -0.5,
                        color: "text.secondary",
                      }}
                    >
                      Select all that apply
                    </Typography>
                  )}
                  {visibleOptions(question).map(option => (
                    <OptionRow
                      key={option}
                      label={option}
                      selected={answer.selected.includes(option)}
                      multiple={Boolean(question.allowMultiple)}
                      recommended={
                        !question.allowMultiple &&
                        question.recommendedOption === option
                      }
                      onToggle={() => toggleOption(question, option)}
                    />
                  ))}
                  {showsOtherRow(question) &&
                    (answer.otherSelected ? (
                      /* In-place edit: the row itself becomes the input */
                      <Box
                        sx={{
                          ...OPTION_ROW_SX,
                          cursor: "text",
                          backgroundColor: "action.selected",
                        }}
                      >
                        <Box
                          role="button"
                          aria-label="Deselect Other"
                          onClick={() => toggleOther(question)}
                          sx={{
                            display: "flex",
                            alignItems: "center",
                            flexShrink: 0,
                            color: "primary.main",
                            cursor: "pointer",
                          }}
                        >
                          <PenLine size={14} />
                        </Box>
                        <InputBase
                          autoFocus
                          fullWidth
                          multiline
                          maxRows={3}
                          placeholder="Type your answer…"
                          value={answer.otherText}
                          onChange={e =>
                            updateAnswer(question.id, {
                              otherText: e.target.value,
                            })
                          }
                          onKeyDown={e => {
                            if (e.key === "Escape") {
                              e.preventDefault();
                              toggleOther(question);
                              return;
                            }
                            handleTextKeyDown(e);
                          }}
                          sx={{
                            flex: 1,
                            minWidth: 0,
                            p: 0,
                            fontSize: 13,
                            lineHeight: 1.5,
                          }}
                        />
                      </Box>
                    ) : (
                      <OptionRow
                        label="Other…"
                        selected={false}
                        multiple={Boolean(question.allowMultiple)}
                        icon={<PenLine size={14} />}
                        onToggle={() => toggleOther(question)}
                      />
                    ))}
                </Box>
              ) : (
                <Box sx={{ px: 1 }}>
                  <TextField
                    size="small"
                    fullWidth
                    autoFocus
                    multiline
                    minRows={1}
                    maxRows={4}
                    placeholder="Type your answer…"
                    value={answer.text}
                    onChange={e =>
                      updateAnswer(question.id, { text: e.target.value })
                    }
                    onKeyDown={handleTextKeyDown}
                  />
                </Box>
              )}
            </Box>

            {/* Footer: Back / Skip on the left, Next or Send answers on the right */}
            <Box
              sx={{
                display: "flex",
                alignItems: "center",
                gap: 1,
                px: 1,
                pt: 1,
                pb: 0.5,
              }}
            >
              {step > 0 && (
                <Button
                  size="small"
                  color="inherit"
                  startIcon={<ChevronLeft size={14} />}
                  onClick={handleBack}
                >
                  Back
                </Button>
              )}
              <Button
                size="small"
                color="inherit"
                onClick={handleSkip}
                sx={{ color: "text.secondary" }}
              >
                Skip
              </Button>
              <Button
                size="small"
                variant="contained"
                onClick={handleNext}
                sx={{ ml: "auto" }}
              >
                {isLast ? "Send answers" : "Next"}
              </Button>
            </Box>
          </>
        )
      )}
    </Box>
  );
};
