const encoder = new TextEncoder();

export type StreamExportFormat = "ndjson" | "csv";

function escapeCsvCell(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }

  const raw = typeof value === "object" ? JSON.stringify(value) : String(value);
  const escaped = raw.replace(/"/g, '""');
  return /[",\n\r]/.test(escaped) ? `"${escaped}"` : escaped;
}

function resolveColumnOrder(rows: Array<Record<string, unknown>>): string[] {
  const columns = new Set<string>();
  for (const row of rows) {
    Object.keys(row || {}).forEach(key => columns.add(key));
  }
  return Array.from(columns);
}

export function createStreamingExportResponse(options: {
  format: StreamExportFormat;
  filename: string;
  streamRows: (
    emitRows: (rows: Array<Record<string, unknown>>) => Promise<void>,
  ) => Promise<{ totalRows: number }>;
}): Response {
  const headers = new Headers();
  headers.set(
    "Content-Type",
    options.format === "ndjson"
      ? "application/x-ndjson; charset=utf-8"
      : "text/csv; charset=utf-8",
  );
  headers.set(
    "Content-Disposition",
    `attachment; filename="${options.filename}"`,
  );
  headers.set("Cache-Control", "no-store");

  let csvHeaderWritten = false;
  let csvColumns: string[] = [];

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      void (async () => {
        try {
          await options.streamRows(async rows => {
            if (options.format === "ndjson") {
              for (const row of rows) {
                controller.enqueue(encoder.encode(`${JSON.stringify(row)}\n`));
              }
              return;
            }

            if (!csvHeaderWritten) {
              csvColumns = resolveColumnOrder(rows);
              if (csvColumns.length > 0) {
                controller.enqueue(encoder.encode(`${csvColumns.join(",")}\n`));
              }
              csvHeaderWritten = true;
            }

            for (const row of rows) {
              const line = csvColumns
                .map(column => escapeCsvCell(row?.[column]))
                .join(",");
              controller.enqueue(encoder.encode(`${line}\n`));
            }
          });

          controller.close();
        } catch (error) {
          controller.error(error);
        }
      })();
    },
  });

  return new Response(stream, { headers });
}
