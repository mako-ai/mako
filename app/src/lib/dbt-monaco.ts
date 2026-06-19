/**
 * dbt Jinja-SQL Monaco language: highlighting for `{{ ... }}`, `{% ... %}`,
 * `{# ... #}` on top of SQL, plus completions for dbt functions and `ref()`
 * model names. Reference: dbt Cloud Studio editor (screenshot 49).
 *
 * Token names intentionally reuse Monaco's standard token types
 * (keyword/type/string/comment/number/predefined/delimiter) so the default
 * `vs` / `vs-dark` themes colour them without any global theme override.
 */
import type { Monaco } from "@monaco-editor/react";

export const DBT_JINJA_LANGUAGE_ID = "jinja-sql";

const SQL_KEYWORDS = [
  "select",
  "from",
  "where",
  "group",
  "by",
  "order",
  "having",
  "limit",
  "offset",
  "as",
  "join",
  "left",
  "right",
  "inner",
  "outer",
  "full",
  "cross",
  "on",
  "using",
  "union",
  "all",
  "distinct",
  "with",
  "and",
  "or",
  "not",
  "in",
  "is",
  "null",
  "like",
  "ilike",
  "between",
  "case",
  "when",
  "then",
  "else",
  "end",
  "cast",
  "over",
  "partition",
  "insert",
  "into",
  "values",
  "update",
  "set",
  "delete",
  "create",
  "table",
  "view",
  "drop",
  "alter",
  "add",
  "asc",
  "desc",
  "exists",
  "unnest",
  "qualify",
  "window",
];

const SQL_BUILTINS = [
  "count",
  "sum",
  "avg",
  "min",
  "max",
  "coalesce",
  "nullif",
  "row_number",
  "rank",
  "dense_rank",
  "lag",
  "lead",
  "date_trunc",
  "date_diff",
  "current_date",
  "current_timestamp",
  "extract",
  "concat",
  "lower",
  "upper",
  "trim",
  "length",
  "round",
  "floor",
  "ceil",
  "abs",
  "array_agg",
  "string_agg",
  "cast",
  "safe_cast",
];

/** dbt/Jinja functions usable inside `{{ ... }}`. */
const DBT_FUNCTIONS = [
  "ref",
  "source",
  "config",
  "var",
  "env_var",
  "this",
  "target",
  "is_incremental",
  "run_query",
  "statement",
  "load_result",
  "adapter",
  "builtins",
  "exceptions",
  "log",
  "return",
  "fromjson",
  "tojson",
  "fromyaml",
  "toyaml",
  "zip",
  "dbt_utils",
];

/** Jinja statement keywords usable inside `{% ... %}`. */
const JINJA_KEYWORDS = [
  "if",
  "elif",
  "else",
  "endif",
  "for",
  "endfor",
  "in",
  "set",
  "endset",
  "macro",
  "endmacro",
  "call",
  "endcall",
  "filter",
  "endfilter",
  "block",
  "endblock",
  "do",
  "with",
  "endwith",
  "raw",
  "endraw",
  "import",
  "from",
  "include",
  "snapshot",
  "endsnapshot",
  "materialization",
  "endmaterialization",
  "test",
  "endtest",
];

let languageRegistered = false;

/** Register the `jinja-sql` Monaco language (idempotent; Monaco is a singleton). */
export function registerDbtJinjaLanguage(monaco: Monaco): void {
  if (languageRegistered) return;
  const { languages } = monaco;
  if (languages.getLanguages().some(l => l.id === DBT_JINJA_LANGUAGE_ID)) {
    languageRegistered = true;
    return;
  }

  languages.register({ id: DBT_JINJA_LANGUAGE_ID });

  languages.setLanguageConfiguration(DBT_JINJA_LANGUAGE_ID, {
    comments: { lineComment: "--", blockComment: ["/*", "*/"] },
    brackets: [
      ["(", ")"],
      ["[", "]"],
      ["{", "}"],
    ],
    autoClosingPairs: [
      { open: "(", close: ")" },
      { open: "[", close: "]" },
      { open: "{", close: "}" },
      { open: "'", close: "'" },
      { open: '"', close: '"' },
      { open: "{{", close: " }}" },
      { open: "{%", close: " %}" },
    ],
    surroundingPairs: [
      { open: "(", close: ")" },
      { open: "'", close: "'" },
      { open: '"', close: '"' },
    ],
  });

  languages.setMonarchTokensProvider(DBT_JINJA_LANGUAGE_ID, {
    defaultToken: "",
    tokenPostfix: ".sql",
    ignoreCase: true,
    keywords: SQL_KEYWORDS,
    builtins: SQL_BUILTINS,
    dbtFunctions: DBT_FUNCTIONS,
    jinjaKeywords: JINJA_KEYWORDS,
    tokenizer: {
      root: [
        [/\{\{-?/, { token: "delimiter.curly", next: "@jinjaExpr" }],
        [/\{%-?/, { token: "delimiter.curly", next: "@jinjaStmt" }],
        [/\{#/, { token: "comment", next: "@jinjaComment" }],
        [/--.*$/, "comment"],
        [/\/\*/, { token: "comment", next: "@blockComment" }],
        [/'/, { token: "string", next: "@stringSingle" }],
        [/"/, { token: "string", next: "@stringDouble" }],
        [/\d+(\.\d+)?/, "number"],
        [
          /[a-zA-Z_]\w*/,
          {
            cases: {
              "@keywords": "keyword",
              "@builtins": "predefined",
              "@default": "identifier",
            },
          },
        ],
        [/[;,.]/, "delimiter"],
        [/[()[\]]/, "@brackets"],
      ],
      jinjaExpr: [
        [/-?\}\}/, { token: "delimiter.curly", next: "@pop" }],
        [
          /[a-zA-Z_]\w*/,
          { cases: { "@dbtFunctions": "type", "@default": "variable" } },
        ],
        [/'[^']*'/, "string"],
        [/"[^"]*"/, "string"],
        [/\d+(\.\d+)?/, "number"],
        [/[()[\],.|=]/, "delimiter"],
      ],
      jinjaStmt: [
        [/-?%\}/, { token: "delimiter.curly", next: "@pop" }],
        [
          /[a-zA-Z_]\w*/,
          { cases: { "@jinjaKeywords": "keyword", "@default": "variable" } },
        ],
        [/'[^']*'/, "string"],
        [/"[^"]*"/, "string"],
        [/\d+(\.\d+)?/, "number"],
        [/[()[\],.|=]/, "delimiter"],
      ],
      jinjaComment: [
        [/#\}/, { token: "comment", next: "@pop" }],
        [/./, "comment"],
      ],
      blockComment: [
        [/\*\//, { token: "comment", next: "@pop" }],
        [/./, "comment"],
      ],
      stringSingle: [
        [/[^']+/, "string"],
        [/'/, { token: "string", next: "@pop" }],
      ],
      stringDouble: [
        [/[^"]+/, "string"],
        [/"/, { token: "string", next: "@pop" }],
      ],
    },
  } as Parameters<typeof languages.setMonarchTokensProvider>[1]);

  languageRegistered = true;
}

export type DbtCompletionContext = {
  /** Model names available for `ref('…')`. */
  getModelNames: () => string[];
};

let completionContext: DbtCompletionContext | null = null;
let completionDisposable: { dispose: () => void } | null = null;

/**
 * Register a single global completion provider for `jinja-sql`. The active
 * context (model names) is read dynamically per request so one provider serves
 * every open dbt file.
 */
export function registerDbtCompletions(
  monaco: Monaco,
  context: DbtCompletionContext,
): void {
  completionContext = context;
  if (completionDisposable) return;

  completionDisposable = monaco.languages.registerCompletionItemProvider(
    DBT_JINJA_LANGUAGE_ID,
    {
      triggerCharacters: ["{", "(", "'", '"', " ", "%"],
      provideCompletionItems: (model, position) => {
        const word = model.getWordUntilPosition(position);
        const range = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn,
        };
        const lineUntil = model.getValueInRange({
          startLineNumber: position.lineNumber,
          startColumn: 1,
          endLineNumber: position.lineNumber,
          endColumn: position.column,
        });
        const { CompletionItemKind, CompletionItemInsertTextRule } =
          monaco.languages;

        // Inside ref('… → suggest model names.
        const refMatch = /\bref\(\s*['"]([^'"]*)$/.exec(lineUntil);
        if (refMatch) {
          const names = completionContext?.getModelNames() ?? [];
          return {
            suggestions: names.map(name => ({
              label: name,
              kind: CompletionItemKind.Class,
              insertText: name,
              detail: "dbt model",
              range,
            })),
          };
        }

        const insideExpr = isInsideJinja(lineUntil, "{{", "}}");
        const insideStmt = isInsideJinja(lineUntil, "{%", "%}");

        if (insideExpr) {
          return { suggestions: dbtFunctionSnippets(monaco, range) };
        }
        if (insideStmt) {
          return {
            suggestions: JINJA_KEYWORDS.map(kw => ({
              label: kw,
              kind: CompletionItemKind.Keyword,
              insertText: kw,
              range,
            })),
          };
        }

        // Bare context: offer the Jinja block snippets so authors can start one.
        return {
          suggestions: [
            {
              label: "ref",
              kind: CompletionItemKind.Snippet,
              insertText: "{{ ref('${1:model}') }}",
              insertTextRules: CompletionItemInsertTextRule.InsertAsSnippet,
              detail: "dbt ref()",
              range,
            },
            {
              label: "source",
              kind: CompletionItemKind.Snippet,
              insertText: "{{ source('${1:source}', '${2:table}') }}",
              insertTextRules: CompletionItemInsertTextRule.InsertAsSnippet,
              detail: "dbt source()",
              range,
            },
            {
              label: "config",
              kind: CompletionItemKind.Snippet,
              insertText: "{{ config(materialized='${1:table}') }}",
              insertTextRules: CompletionItemInsertTextRule.InsertAsSnippet,
              detail: "dbt config()",
              range,
            },
            {
              label: "if-incremental",
              kind: CompletionItemKind.Snippet,
              insertText:
                "{% if is_incremental() %}\n  ${1:-- incremental filter}\n{% endif %}",
              insertTextRules: CompletionItemInsertTextRule.InsertAsSnippet,
              detail: "dbt incremental block",
              range,
            },
          ],
        };
      },
    },
  );
}

function dbtFunctionSnippets(
  monaco: Monaco,
  range: {
    startLineNumber: number;
    endLineNumber: number;
    startColumn: number;
    endColumn: number;
  },
) {
  const { CompletionItemKind, CompletionItemInsertTextRule } = monaco.languages;
  const snippet = (label: string, insertText: string, detail: string) => ({
    label,
    kind: CompletionItemKind.Function,
    insertText,
    insertTextRules: CompletionItemInsertTextRule.InsertAsSnippet,
    detail,
    range,
  });
  return [
    snippet("ref", "ref('${1:model}')", "Reference another model"),
    snippet(
      "source",
      "source('${1:source}', '${2:table}')",
      "Reference a source",
    ),
    snippet("config", "config(materialized='${1:table}')", "Model config"),
    snippet("var", "var('${1:name}'${2:, default})", "Project variable"),
    snippet(
      "env_var",
      "env_var('${1:DBT_KEY}'${2:, 'default'})",
      "Environment variable",
    ),
    snippet("is_incremental", "is_incremental()", "True on incremental runs"),
    ...["this", "target"].map(name => ({
      label: name,
      kind: CompletionItemKind.Variable,
      insertText: name,
      detail: `dbt ${name}`,
      range,
    })),
  ];
}

/** Whether the cursor sits inside an unclosed Jinja delimiter on this line. */
function isInsideJinja(
  lineUntil: string,
  open: string,
  close: string,
): boolean {
  const lastOpen = lineUntil.lastIndexOf(open);
  if (lastOpen === -1) return false;
  const lastClose = lineUntil.lastIndexOf(close);
  return lastClose < lastOpen;
}
