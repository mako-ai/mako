/** Tiny logger so ACP modules don't depend on the API logging stack in tests. */
export const acpLog = {
  info(message: string, fields?: Record<string, unknown>): void {
    if (process.env.MAKO_ACP_SILENT === "1") return;
    console.error(`[acp] ${message}`, fields ? JSON.stringify(fields) : "");
  },
  error(message: string, fields?: Record<string, unknown>): void {
    console.error(`[acp:error] ${message}`, fields ? JSON.stringify(fields) : "");
  },
};
