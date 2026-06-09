import React, { useMemo, useState } from "react";
import { Box, Button, Chip, Stack, TextField, Typography } from "@mui/material";
import { HelpCircle } from "lucide-react";
import type {
  AskClarifyingQuestionsInput,
  AskClarifyingQuestionsOutput,
  ClarifyingQuestion,
} from "@mako/agent-tools";

interface ClarifyingQuestionsCardProps {
  input?: AskClarifyingQuestionsInput;
  /** Present once the tool has been resolved (read-only summary view). */
  output?: AskClarifyingQuestionsOutput;
  onResolve: (output: AskClarifyingQuestionsOutput) => void;
}

type AnswerMap = Record<string, string | string[]>;

function initialAnswers(questions: ClarifyingQuestion[]): AnswerMap {
  const map: AnswerMap = {};
  for (const q of questions) {
    map[q.id] = q.type === "choice" && q.allowMultiple ? [] : "";
  }
  return map;
}

/**
 * Inline form for the deferred `ask_clarifying_questions` tool. Renders
 * choice/text/multi questions and resolves the tool call via `onResolve` once
 * the user submits or skips.
 */
export const ClarifyingQuestionsCard: React.FC<
  ClarifyingQuestionsCardProps
> = ({ input, output, onResolve }) => {
  const questions = useMemo(() => input?.questions ?? [], [input]);
  const [answers, setAnswers] = useState<AnswerMap>(() =>
    initialAnswers(questions),
  );
  const resolved = Boolean(output);

  const setSingle = (id: string, value: string) =>
    setAnswers(prev => ({ ...prev, [id]: value }));

  const toggleMulti = (id: string, value: string) =>
    setAnswers(prev => {
      const current = Array.isArray(prev[id]) ? (prev[id] as string[]) : [];
      return {
        ...prev,
        [id]: current.includes(value)
          ? current.filter(v => v !== value)
          : [...current, value],
      };
    });

  const handleSubmit = () => {
    if (resolved) return;
    onResolve({
      success: true,
      answers: questions.map(q => ({
        id: q.id,
        prompt: q.prompt,
        response: answers[q.id] ?? "",
      })),
    });
  };

  const handleSkip = () => {
    if (resolved) return;
    onResolve({ success: true, skipped: true });
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
                <Stack
                  direction="row"
                  spacing={0.75}
                  flexWrap="wrap"
                  useFlexGap
                >
                  {(question.options ?? []).map(option => {
                    const selected = question.allowMultiple
                      ? Array.isArray(answers[question.id]) &&
                        (answers[question.id] as string[]).includes(option)
                      : answers[question.id] === option;
                    return (
                      <Chip
                        key={option}
                        label={option}
                        size="small"
                        color={selected ? "primary" : "default"}
                        variant={selected ? "filled" : "outlined"}
                        onClick={() =>
                          question.allowMultiple
                            ? toggleMulti(question.id, option)
                            : setSingle(question.id, option)
                        }
                      />
                    );
                  })}
                </Stack>
              ) : (
                <TextField
                  size="small"
                  fullWidth
                  multiline
                  minRows={1}
                  maxRows={4}
                  placeholder="Type your answer…"
                  value={(answers[question.id] as string) ?? ""}
                  onChange={e => setSingle(question.id, e.target.value)}
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
