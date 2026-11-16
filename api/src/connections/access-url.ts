/**
 * The app page of a source connection. Its Access tab is where the workspace
 * owner or a manager switches live reads on and lists readers and writers.
 */
export function connectionAccessUrl(connectionId: string): string {
  const base = (
    process.env.CLIENT_URL ||
    process.env.PUBLIC_URL ||
    "http://localhost:5173"
  ).replace(/\/$/, "");
  return `${base}/cx/${connectionId}`;
}
