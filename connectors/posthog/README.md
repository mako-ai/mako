# PostHog connector

Reads 5 entities from the PostHog REST API: `surveys`, `survey_responses`,
`feature_flags`, `experiments` and `annotations`. See `connector.yaml` for the
config and `CHANGELOG.md` for what changed.

## Query entities

The built-in connector this folder replaces synced a flow's HogQL queries as
tables (`queries` on the flow, one entity per query). The folder does not.
The SDK declares entities statically, and 0 production flows used query
entities when they were removed. Live HogQL reads still work through
`call_connection` with `hogql`.

If a customer asks for them back, add a `queries` entity form to the folder:

1. Declare an entity per query from the flow's `queries` (name, HogQL text,
   batch size), using the SDK's dynamic-entity form if it has one by then.
2. Run each query through the client's query endpoint
   (`POST /api/projects/:id/query` with `{ query: { kind: "HogQLQuery", query } }`).
3. Page by appending `LIMIT`/`OFFSET` when the text has no `$limit` and
   `$offset` placeholders, and fill `$since` / `{{since}}` from the
   incremental state.
4. Add golden rows and a cassette for one query, as for the 5 entities.

The reference is the old built-in code at commit `6be789dd2`, the master
commit before it was deleted: `api/src/connectors/posthog/connector.ts` and
its `connector.test.ts`.
