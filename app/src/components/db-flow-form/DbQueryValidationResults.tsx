import { Box, Typography, Alert, Chip } from "@mui/material";
import {
  CheckCircle as CheckIcon,
  Warning as WarningIcon,
} from "@mui/icons-material";
import type { DbFlowFormModel } from "./useDbFlowForm";

export function DbQueryValidationResults({
  model,
}: {
  model: DbFlowFormModel;
}) {
  const { validationResult } = model;
  return (
    <>
      {validationResult && (
        <Box sx={{ mt: 1 }}>
          {validationResult.success ? (
            <Alert severity="success" icon={<CheckIcon />} sx={{ mb: 1 }}>
              <Typography
                variant="body2"
                sx={{
                  fontWeight: "medium",
                }}
              >
                Query validated successfully
              </Typography>
              {validationResult.columns &&
                validationResult.columns.length > 0 && (
                  <Box sx={{ mt: 1 }}>
                    <Typography
                      variant="caption"
                      sx={{
                        color: "text.secondary",
                      }}
                    >
                      Columns ({validationResult.columns.length}
                      ):
                    </Typography>
                    <Box
                      sx={{
                        display: "flex",
                        flexWrap: "wrap",
                        gap: 0.5,
                        mt: 0.5,
                      }}
                    >
                      {validationResult.columns.map((col, idx) => (
                        <Chip
                          key={idx}
                          label={`${col.name} (${col.type})`}
                          size="small"
                          variant="outlined"
                          sx={{ fontSize: "0.75rem" }}
                        />
                      ))}
                    </Box>
                  </Box>
                )}
            </Alert>
          ) : (
            <Alert severity="error" sx={{ mb: 1 }}>
              <Typography variant="body2">
                {validationResult.error || "Query validation failed"}
              </Typography>
            </Alert>
          )}

          {validationResult.warnings &&
            validationResult.warnings.length > 0 && (
              <Alert severity="warning" icon={<WarningIcon />} sx={{ mb: 1 }}>
                <Typography
                  variant="body2"
                  sx={{
                    fontWeight: "medium",
                  }}
                >
                  Suggestions:
                </Typography>
                <ul
                  style={{
                    margin: "4px 0 0 0",
                    paddingLeft: "20px",
                  }}
                >
                  {validationResult.warnings.map((warning, idx) => (
                    <li key={idx}>
                      <Typography variant="body2">{warning}</Typography>
                    </li>
                  ))}
                </ul>
              </Alert>
            )}

          {validationResult.sampleRow && (
            <Box
              sx={{
                mt: 1,
                p: 1.5,
                bgcolor: "action.hover",
                borderRadius: 1,
                overflow: "auto",
              }}
            >
              <Typography
                variant="caption"
                gutterBottom
                sx={{
                  color: "text.secondary",
                }}
              >
                Sample row:
              </Typography>
              <Box
                component="pre"
                sx={{
                  m: 0,
                  mt: 0.5,
                  fontSize: "0.75rem",
                  fontFamily: "monospace",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-all",
                }}
              >
                {JSON.stringify(validationResult.sampleRow, null, 2)}
              </Box>
            </Box>
          )}
        </Box>
      )}
    </>
  );
}
