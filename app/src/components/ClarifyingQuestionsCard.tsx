import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, ButtonBase, InputBase, Typography } from "@mui/material";
import { keyframes } from "@mui/material/styles";
import {
  ArrowUp,
  Check,
  ChevronLeft,
  ChevronRight,
  Circle,
  HelpCircle,
  PenLine,
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

const OPTION_ROW_SX = {
  display: "flex",
  alignItems: "center",
  gap: 1.25,
  px: 1,
  py: 0.5,
  minHeight: 32,
  width: "100%",
  borderRadius: "8px",
  cursor: "pointer",
  userSelect: "none",
  textAlign: "left",
  transition: "background-color 0.1s",
  "&:hover": { backgroundColor: "var(--bui-hover)" },
} as const;

/**
 * Beautiful UI selection indicator: a filled ink circle/rounded-square with a
 * surface-colored dot/check when selected, a hairline inset ring otherwise.
 */
const SelectIndicator: React.FC<{ selected: boolean; multiple: boolean }> = ({
  selected,
  multiple,
}) => (
  <Box
    sx={{
      width: 16,
      height: 16,
      flexShrink: 0,
      borderRadius: multiple ? "5px" : "50%",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      transition: "background-color 0.2s, box-shadow 0.2s",
      ...(selected
        ? { backgroundColor: "var(--bui-ink)", color: "var(--bui-surface)" }
        : {
            boxShadow: "inset 0 0 0 1.5px var(--bui-line-strong)",
            color: "transparent",
          }),
    }}
  >
    {multiple ? (
      <Check size={11} strokeWidth={3} />
    ) : (
      <Box
        sx={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          backgroundColor: "var(--bui-surface)",
          transition: "transform 0.2s",
          transform: selected ? "scale(1)" : "scale(0)",
        }}
      />
    )}
  </Box>
);

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
}) => (
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
    sx={OPTION_ROW_SX}
  >
    {icon ? (
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 16,
          flexShrink: 0,
          color: "var(--bui-ink-3)",
        }}
      >
        {icon}
      </Box>
    ) : (
      <SelectIndicator selected={selected} multiple={multiple} />
    )}
    <Typography
      sx={{
        fontSize: 13,
        flex: 1,
        minWidth: 0,
        transition: "color 0.2s",
        color: selected ? "var(--bui-ink)" : "var(--bui-ink-2)",
      }}
    >
      {label}
    </Typography>
    {recommended && (
      <Box
        component="span"
        sx={{
          flexShrink: 0,
          px: 0.75,
          py: 0.125,
          borderRadius: "999px",
          backgroundColor: "var(--bui-accent-tint)",
          color: "var(--bui-accent-ink)",
          fontSize: 10,
          fontWeight: 600,
        }}
      >
        Recommended
      </Box>
    )}
  </Box>
);

/** Ring-dot pager (BUI Approval Card): current = thick ring, done = filled. */
const PagerDots: React.FC<{
  count: number;
  step: number;
  onGo: (i: number) => void;
}> = ({ count, step, onGo }) => (
  <Box
    component="span"
    sx={{ display: "flex", alignItems: "center", gap: 0.5 }}
  >
    {Array.from({ length: count }, (_, i) => (
      <ButtonBase
        key={i}
        aria-label={`Go to question ${i + 1}`}
        aria-current={i === step ? "step" : undefined}
        onClick={() => onGo(i)}
        sx={{
          borderRadius: "50%",
          p: 0,
          transition:
            "width 0.3s, height 0.3s, background-color 0.3s, border-color 0.3s",
          ...(i === step
            ? { width: 9, height: 9, border: "2.5px solid var(--bui-ink)" }
            : i < step
              ? { width: 7, height: 7, backgroundColor: "var(--bui-ink-3)" }
              : {
                  width: 7,
                  height: 7,
                  border: "1.5px solid var(--bui-ink-3)",
                }),
        }}
      />
    ))}
  </Box>
);

const PAGER_CHEVRON_SX = {
  width: 24,
  height: 24,
  borderRadius: "5px",
  color: "var(--bui-ink-3)",
  transition: "background-color 0.1s, color 0.1s",
  "&:hover": { backgroundColor: "var(--bui-hover)", color: "var(--bui-ink-2)" },
  "&.Mui-disabled": { opacity: 0.35 },
} as const;

/**
 * Beautiful UI "Approval Card" wizard for the deferred
 * `ask_clarifying_questions` tool: one question per screen, ink-filled
 * radio/checkbox rows, an optional "Other" free-text row, a ring-dot pager
 * with chevrons, and an arrow button that advances (sends on the last step).
 * Resolves via `onResolve` on submit or skip. With `output` present it
 * renders a compact read-only summary instead.
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
    }, 250);
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

  const goToStep = (i: number) => {
    cancelScheduledAdvance();
    setStep(Math.min(Math.max(i, 0), lastStep));
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

  // Drives the send-arrow affordance only — advancing stays always possible
  // (unanswered questions submit as empty, same as before the redesign).
  const hasCurrentAnswer =
    question?.type === "text"
      ? answer.text.trim().length > 0
      : answer.selected.length > 0 ||
        (answer.otherSelected && answer.otherText.trim().length > 0);

  return (
    <Box
      sx={{
        borderRadius: "14px",
        backgroundColor: "var(--bui-surface)",
        boxShadow: "var(--bui-shadow-card)",
        p: 0.5,
        ...(docked
          ? {
              borderBottomLeftRadius: 0,
              borderBottomRightRadius: 0,
              transformOrigin: "bottom",
              animation: `${cardSlideUp} 220ms cubic-bezier(0.4, 0, 0.2, 1)`,
            }
          : { my: 0.5 }),
      }}
    >
      {/* Header */}
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 0.75,
          px: 1,
          py: 0.5,
          color: "var(--bui-ink-3)",
        }}
      >
        <HelpCircle size={13} />
        <Typography
          variant="caption"
          sx={{ fontWeight: 600, letterSpacing: 0.2, fontSize: 11.5 }}
        >
          Clarifying questions
        </Typography>
        {resolved && (
          <Box
            component="span"
            sx={{
              ml: "auto",
              display: "inline-flex",
              alignItems: "center",
              gap: 0.5,
              px: 1,
              py: 0.25,
              borderRadius: "999px",
              fontSize: 11,
              fontWeight: 600,
              ...(output?.skipped
                ? {
                    backgroundColor: "var(--bui-field)",
                    color: "var(--bui-ink-2)",
                  }
                : {
                    backgroundColor: "var(--bui-green-tint)",
                    color: "var(--bui-green)",
                  }),
            }}
          >
            {!output?.skipped && <Check size={11} strokeWidth={3} />}
            {output?.skipped ? "Skipped" : "Answered"}
          </Box>
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
                    color: "var(--bui-ink-3)",
                    flexShrink: 0,
                  }}
                >
                  <Circle size={10} />
                </Box>
                <Typography sx={{ fontSize: 13, minWidth: 0 }}>
                  <Box component="span" sx={{ color: "var(--bui-ink-2)" }}>
                    {q.prompt}
                  </Box>
                  <Box component="span" sx={{ color: "var(--bui-ink-3)" }}>
                    {" — "}
                  </Box>
                  <Box component="span" sx={{ color: "var(--bui-ink)" }}>
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
              sx={{
                px: 0.5,
                animation: "bui-fade-up 350ms cubic-bezier(0.23,1,0.32,1) both",
              }}
            >
              <Typography
                sx={{
                  fontSize: 13,
                  fontWeight: 500,
                  color: "var(--bui-ink)",
                  px: 1,
                  pt: 0.5,
                  pb: 0.75,
                }}
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
                        color: "var(--bui-ink-3)",
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
                          backgroundColor: "var(--bui-hover)",
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
                            color: "var(--bui-ink)",
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
                          placeholder="Type something…"
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
                            color: "var(--bui-ink)",
                            "& .MuiInputBase-input::placeholder": {
                              color: "var(--bui-ink-3)",
                              opacity: 1,
                            },
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
                <Box
                  sx={{
                    mx: 1,
                    mb: 0.5,
                    px: 1,
                    py: 0.5,
                    borderRadius: "8px",
                    backgroundColor: "var(--bui-field)",
                    boxShadow: "var(--bui-shadow-hairline)",
                  }}
                >
                  <InputBase
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
                    sx={{
                      p: 0,
                      fontSize: 13,
                      color: "var(--bui-ink)",
                      "& .MuiInputBase-input::placeholder": {
                        color: "var(--bui-ink-3)",
                        opacity: 1,
                      },
                    }}
                  />
                </Box>
              )}
            </Box>

            {/* Footer: chevron + ring-dot pager left, Skip + arrow right */}
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
              {questions.length > 1 && (
                <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                  <ButtonBase
                    aria-label="Previous question"
                    disabled={step === 0}
                    onClick={() => goToStep(step - 1)}
                    sx={PAGER_CHEVRON_SX}
                  >
                    <ChevronLeft size={14} />
                  </ButtonBase>
                  <PagerDots
                    count={questions.length}
                    step={step}
                    onGo={goToStep}
                  />
                  <ButtonBase
                    aria-label="Next question"
                    disabled={isLast}
                    onClick={() => goToStep(step + 1)}
                    sx={PAGER_CHEVRON_SX}
                  >
                    <ChevronRight size={14} />
                  </ButtonBase>
                </Box>
              )}
              <ButtonBase
                onClick={handleSkip}
                sx={{
                  ml: "auto",
                  px: 0.75,
                  py: 0.25,
                  borderRadius: "6px",
                  fontSize: 12,
                  fontWeight: 500,
                  color: "var(--bui-ink-3)",
                  transition: "color 0.15s",
                  "&:hover": { color: "var(--bui-ink)" },
                }}
              >
                Skip
              </ButtonBase>
              <ButtonBase
                aria-label={isLast ? "Send answers" : "Next question"}
                onClick={handleNext}
                sx={{
                  width: 28,
                  height: 28,
                  borderRadius: "8px",
                  transition:
                    "background-color 0.2s, color 0.2s, transform 0.1s",
                  "&:active": { transform: "scale(0.96)" },
                  ...(hasCurrentAnswer
                    ? {
                        backgroundColor: "var(--bui-ink)",
                        color: "var(--bui-surface)",
                        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.14)",
                      }
                    : {
                        backgroundColor: "var(--bui-field)",
                        color: "var(--bui-ink-3)",
                        boxShadow: "var(--bui-shadow-btn)",
                      }),
                }}
              >
                <ArrowUp size={14} strokeWidth={2.5} />
              </ButtonBase>
            </Box>
          </>
        )
      )}
    </Box>
  );
};
