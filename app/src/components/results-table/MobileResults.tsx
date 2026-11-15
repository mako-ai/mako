import React from "react";
import { Box, Chip, Typography } from "@mui/material";
import type { GridColDef } from "@mui/x-data-grid-premium";
import VSScrollArea from "../VSScrollArea";
import {
  cardTitle,
  MONO_FONT_FAMILY,
  singleValueKpi,
  statusChipColor,
  type QueryResult,
} from "./grid-model";

// Max record cards rendered at once on mobile (cards are not virtualized).
export const MOBILE_CARD_LIMIT = 200;

const CARD_VALUE_TEXT_SX = { wordBreak: "break-word", textAlign: "right" };

function CardValue({ value }: { value: unknown }) {
  if (value === null || value === undefined) {
    return (
      <Typography variant="body2" sx={{ color: "text.disabled" }}>
        —
      </Typography>
    );
  }
  if (typeof value === "object") {
    return (
      <Typography
        variant="body2"
        sx={{
          ...CARD_VALUE_TEXT_SX,
          fontFamily: MONO_FONT_FAMILY,
          fontSize: "0.75rem",
        }}
      >
        {JSON.stringify(value)}
      </Typography>
    );
  }
  const str = String(value);
  const chipColor = statusChipColor(str);
  if (chipColor) {
    return (
      <Chip size="small" variant="outlined" color={chipColor} label={str} />
    );
  }
  return (
    <Typography variant="body2" sx={CARD_VALUE_TEXT_SX}>
      {str}
    </Typography>
  );
}

/**
 * Mobile record cards. Renders up to a cap so large result sets don't blow up
 * the DOM (cards are not virtualized like the DataGrid); beyond the cap we
 * point users at the Table view.
 */
export function ResultsCards({
  rows,
  dataColumns,
}: {
  rows: any[];
  dataColumns: GridColDef[];
}) {
  const cardRows = rows.slice(0, MOBILE_CARD_LIMIT);
  const [titleCol, ...restCols] = dataColumns;
  return (
    <VSScrollArea style={{ height: "100%" }}>
      <Box sx={{ p: 1, display: "flex", flexDirection: "column", gap: 1 }}>
        {cardRows.map((row, index) => (
          <Box
            key={row.id ?? index}
            sx={{
              border: 1,
              borderColor: "divider",
              borderRadius: 1,
              p: 1.5,
              backgroundColor: "background.paper",
            }}
          >
            <Typography
              variant="subtitle2"
              sx={{
                fontWeight: 700,
                mb: restCols.length ? 1 : 0,
                wordBreak: "break-word",
              }}
            >
              {cardTitle(titleCol ? row[titleCol.field] : undefined, index)}
            </Typography>
            {restCols.length > 0 && (
              <Box
                sx={{
                  display: "grid",
                  gridTemplateColumns: "minmax(0, 45%) 1fr",
                  columnGap: 1.5,
                  rowGap: 0.75,
                  alignItems: "start",
                }}
              >
                {restCols.map(col => (
                  <React.Fragment key={col.field}>
                    <Typography
                      variant="caption"
                      sx={{
                        color: "text.secondary",
                        wordBreak: "break-word",
                        pt: 0.25,
                      }}
                    >
                      {col.headerName ?? col.field}
                    </Typography>
                    <Box
                      sx={{
                        minWidth: 0,
                        display: "flex",
                        justifyContent: "flex-end",
                      }}
                    >
                      <CardValue value={row[col.field]} />
                    </Box>
                  </React.Fragment>
                ))}
              </Box>
            )}
          </Box>
        ))}
        {rows.length > MOBILE_CARD_LIMIT && (
          <Typography
            variant="caption"
            sx={{ color: "text.secondary", textAlign: "center", py: 1 }}
          >
            Showing the first {MOBILE_CARD_LIMIT} of {rows.length} rows — switch
            to Table view to see all.
          </Typography>
        )}
      </Box>
    </VSScrollArea>
  );
}

/** Mobile answer-first summary band: a KPI for a single value, else counts. */
export function ResultsSummaryBand({
  results,
  rows,
  dataColumns,
}: {
  results: QueryResult;
  rows: any[];
  dataColumns: GridColDef[];
}) {
  const kpi = singleValueKpi(rows, dataColumns);
  return (
    <Box
      sx={{
        px: 1.5,
        py: 1,
        borderBottom: "1px solid",
        borderColor: "divider",
        backgroundColor: "background.default",
      }}
    >
      {kpi ? (
        <>
          <Typography variant="h5" sx={{ fontWeight: 700, lineHeight: 1.2 }}>
            {kpi.value}
          </Typography>
          <Typography variant="caption" sx={{ color: "text.secondary" }}>
            {kpi.label}
          </Typography>
        </>
      ) : (
        <Box sx={{ display: "flex", alignItems: "baseline", gap: 1 }}>
          <Typography variant="h6" sx={{ fontWeight: 700 }}>
            {results.resultCount.toLocaleString()}
          </Typography>
          <Typography variant="body2" sx={{ color: "text.secondary" }}>
            {results.resultCount === 1 ? "result" : "results"}
            {results.executionTime !== undefined
              ? ` • ${results.executionTime} ms`
              : ""}
          </Typography>
        </Box>
      )}
    </Box>
  );
}
