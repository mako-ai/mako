import React, { useMemo, useState } from "react";
import { Box, Button, Chip, Stack, TextField, Typography } from "@mui/material";
import { HelpCircle, PenLine } from "lucide-react";
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

/**
 * Inline form for the deferred `ask_clarifying_questions` tool. Choice
 * questions render their options as selectable chips plus an "Other" option
 * that reveals a free-text field. Resolves via `onResolve` on submit or skip.
 */
export const ClarifyingQuestionsCard: React.FC<
  ClarifyingQuestionsCardProps
> = ({ input, output, onResolve }) => {
  const questions = useMemo(() => input?.questions ?? [], [input]);
  const [answers, setAnswers] = useState<AnswerMap>({});
  const resolved = Boolean(output);

  const getAnswer = (id: string): QuestionAnswer =>
    answers[id] ?? emptyAnswer();

  const updateAnswer = (id: string, patch: Partial<QuestionAnswer>) =>
    setAnswers(prev => ({
      ...prev,
      [id]: { ...(prev[id] ?? emptyAnswer()), ...patch },
    }));

  const toggleOption = (question: ClarifyingQuestion, option: string) => {
    const answer = getAnswer(question.id);
    if (question.allowMultiple) {
      updateAnswer(question.id, {
        selected: answer.selected.includes(option)
          ? answer.selected.filter(v => v !== option)
          : [...answer.selected, option],
      });
    } else {
      // Single choice: picking an option deselects "Other" and vice versa.
      updateAnswer(question.id, {
        selected: answer.selected.includes(option) ? [] : [option],
        otherSelected: false,
      });
    }
  };

  const toggleOther = (question: ClarifyingQuestion) => {
    const answer = getAnswer(question.id);
    updateAnswer(question.id, {
      otherSelected: !answer.otherSelected,
      ...(question.allowMultiple || answer.otherSelected
        ? {}
        : { selected: [] }),
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

  const handleSkip = () => {
    if (resolved) return;
    onResolve?.({ success: true, skipped: true });
  };

  return (
    <Box
      sx={{
        border: 1,
        borderColor: "divider",
        borderRadius: 2,
        p: 1.5,
        my: 0.5,
        bgcolor: "background.paper",
      }}
    >
      <Stack direction="row" spacing={1} alignItems="center" mb={1}>
        <HelpCircle size={15} />
        <Typography variant="subtitle2" fontWeight={600}>
          Clarifying questions
        </Typography>
        {resolved && (
          <Chip
            size="small"
            label={output?.skipped ? "Skipped" : "Answered"}
            color={output?.skipped ? "default" : "success"}
            variant="outlined"
          />
        )}
      </Stack>

      <Stack spacing={1.5}>
        {questions.map(question => {
          const answer = getAnswer(question.id);
          const resolvedAnswer = output?.answers?.find(
            a => a.id === question.id,
          )?.response;

          return (
            <Box key={question.id}>
              <Typography variant="body2" fontWeight={500} mb={0.75}>
                {question.prompt}
              </Typography>

              {resolved ? (
                <Typography variant="body2" color="text.secondary">
                  {Array.isArray(resolvedAnswer)
                    ? resolvedAnswer.join(", ") || "—"
                    : resolvedAnswer || (output?.skipped ? "Skipped" : "—")}
                </Typography>
              ) : question.type === "choice" ? (
                <>
                  <Stack
                    direction="row"
                    spacing={0.75}
                    flexWrap="wrap"
                    useFlexGap
                  >
                    {(question.options ?? []).map(option => {
                      const selected = answer.selected.includes(option);
                      return (
                        <Chip
                          key={option}
                          label={option}
                          size="small"
                          color={selected ? "primary" : "default"}
                          variant={selected ? "filled" : "outlined"}
                          onClick={() => toggleOption(question, option)}
                        />
                      );
                    })}
                    <Chip
                      icon={<PenLine size={12} />}
                      label="Other"
                      size="small"
                      color={answer.otherSelected ? "primary" : "default"}
                      variant={answer.otherSelected ? "filled" : "outlined"}
                      onClick={() => toggleOther(question)}
                    />
                  </Stack>
                  {answer.otherSelected && (
                    <TextField
                      size="small"
                      fullWidth
                      autoFocus
                      multiline
                      minRows={1}
                      maxRows={4}
                      placeholder="Type your answer…"
                      value={answer.otherText}
                      onChange={e =>
                        updateAnswer(question.id, { otherText: e.target.value })
                      }
                      sx={{ mt: 0.75 }}
                    />
                  )}
                </>
              ) : (
                <TextField
                  size="small"
                  fullWidth
                  multiline
                  minRows={1}
                  maxRows={4}
                  placeholder="Type your answer…"
                  value={answer.text}
                  onChange={e =>
                    updateAnswer(question.id, { text: e.target.value })
                  }
                />
              )}
            </Box>
          );
        })}
      </Stack>

      {!resolved && (
        <Stack direction="row" spacing={1} mt={1.5} justifyContent="flex-end">
          <Button size="small" color="inherit" onClick={handleSkip}>
            Skip
          </Button>
          <Button size="small" variant="contained" onClick={handleSubmit}>
            Send answers
          </Button>
        </Stack>
      )}
    </Box>
  );
};
