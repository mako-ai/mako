# Cross-filtering, interaction & query-failure debugging

## Interaction debugging protocol

When a user reports a widget interaction bug (cross-filter click not working,
hover broken, chart selection failing, etc.):
- Do NOT claim the root cause is confirmed unless it is supported by tool output, schema inspection, query results, or runtime errors.
- If you are not sure, explicitly label it a hypothesis and run one diagnostic step before making one fix.
- Prefer inspecting current dashboard state, widget SQL/spec, source schema, and preview queries before changing the chart.
- After the first attempted fix, do NOT keep stacking adjacent hypotheses. If the issue persists, stop and re-diagnose from the new observed behavior.
- Do not declare success until both the behavior and the chart appearance match the user's report.

## Cross-filter debugging order

For cross-filter issues, verify in this order before changing anything:
1. Dashboard-level cross-filter state (`dashboard.crossFilter.enabled`)
2. Widget-level cross-filter state (`widget.crossFilter.enabled`)
3. The actual clicked dimension field emitted by the chart encoding
4. Whether that dimension is a canonical data-source column (not a widget-level calculated dimension or alias)
5. The DuckDB type of that source column and its sample values from the data source schema
6. Whether the selection value produced by Vega/Mosaic will be predicate-compatible with that DuckDB type
7. Only then decide whether the fix belongs in the Vega-Lite spec, widget SQL, or the source query

## Temporal cross-filter rule

Temporal/date dimensions are a known fragile case for cross-filtering:
- Do NOT assume a temporal encoding problem is caused by dashboard-level settings without verifying them first.
- Do NOT remove or add `timeUnit` speculatively just to test a theory if you have not checked predicate/type compatibility.
- If a date/time selection would produce values that do not compare cleanly against the DuckDB source type, prefer adding a canonical source-level label/dimension in the data source query, then use that canonical field in the widget.
- Do NOT create date labels or derived dimensions in widget `localSql` for cross-filtering. If needed, add them to the data source so they become canonical fields.

## Source query edit safety

When editing a data source query:
- Never use line-number patch edits unless you have verified the current saved query text and exact target lines from the latest dashboard state.
- For repeated literal changes across a long SQL query, prefer replacing the full query from the latest known-good version rather than patching guessed line numbers.
- For small requests like changing a time window, make the smallest safe change possible and preserve the rest of the query byte-for-byte when feasible.
- Only say how many occurrences were changed after verifying the saved query text.
- After any line-based patch, if the next run fails unexpectedly, inspect the current saved query before retrying or making more edits.

## Query failure triage

When `run_data_source_query` fails:
- If `errorKind` is `source_sql_runtime`, assume the SQL may be invalid or semantically broken until proven otherwise. Inspect the saved query before retrying.
- Do NOT call a failure "transient" unless the tool output clearly supports that conclusion.
- Do not retry the same run error more than once without new evidence from the saved query, dashboard state, or a preview query.
- If the data source schema collapses to only `_empty`, or widgets start showing binder errors for previously valid columns, treat that as likely source-query corruption or failed materialization replacing the schema, not as a widget-spec problem.
- If the query was working before your edit, prefer restoring the latest known-good query and then reapplying the intended change safely.
