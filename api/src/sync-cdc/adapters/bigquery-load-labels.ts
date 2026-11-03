/**
 * Labels on the CDC Parquet LOAD jobs (services/bigquery-labels.ts).
 *
 * `table.load(localPath, metadata)` in @google-cloud/bigquery puts ALL of
 * `metadata` under `configuration.load`, while BigQuery reads job labels from
 * `configuration.labels`; a `labels` key inside `load` is rejected. So the
 * adapter passes `labels` in the load metadata and this wrapper on the
 * client's request function moves it to `configuration.labels` in the
 * multipart upload's JSON part before it is sent.
 *
 * Only a client wrapped here may be given load-metadata labels:
 * `canLabelLoadJobs` says so. The SDK shape is pinned by
 * bigquery-labels.test.ts, which runs the real `table.load`.
 */
type RequestFn = (reqOpts: unknown, ...rest: unknown[]) => unknown;

const wrapped = new WeakSet<object>();

/** Move `configuration.load.labels` to `configuration.labels`, in place. */
export function relocateLoadJobLabels(reqOpts: unknown): void {
  const multipart = (reqOpts as { multipart?: unknown })?.multipart;
  if (!Array.isArray(multipart)) return;
  const part = multipart[0] as { body?: unknown } | undefined;
  if (!part || typeof part.body !== "string") return;
  let meta: { configuration?: Record<string, unknown> };
  try {
    meta = JSON.parse(part.body);
  } catch {
    return;
  }
  const configuration = meta.configuration;
  const load = configuration?.load as Record<string, unknown> | undefined;
  if (!configuration || !load || !("labels" in load)) return;
  const labels = load.labels;
  delete load.labels;
  if (labels && typeof labels === "object") configuration.labels = labels;
  part.body = JSON.stringify(meta);
}

/** Wrap a BigQuery client so its load jobs can carry labels. Idempotent. */
export function enableLoadJobLabels(client: {
  makeAuthenticatedRequest: unknown;
}): void {
  if (wrapped.has(client)) return;
  const original = client.makeAuthenticatedRequest as RequestFn;
  if (typeof original !== "function") return;
  const wrapper: RequestFn = (reqOpts, ...rest) => {
    relocateLoadJobLabels(reqOpts);
    return original(reqOpts, ...rest);
  };
  // The SDK hangs authClient / getCredentials off this function.
  Object.assign(wrapper, original);
  client.makeAuthenticatedRequest = wrapper;
  wrapped.add(client);
}

export function canLabelLoadJobs(client: object): boolean {
  return wrapped.has(client);
}
