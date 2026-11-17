/**
 * A synthetic PostHog project the recording server answers from. Shapes
 * follow PostHog's REST responses for the 5 built-in entities; values are
 * made up and deterministic (a seeded generator), so re-recording gives the
 * same cassettes.
 *
 * Sizes are chosen to cross every boundary the connectors have:
 * - 6 surveys, one of them archived, created on both sides of `SINCE`;
 * - 230 responses on one survey (3 pages of 100), 0 on another, 3 to 40 on
 *   the rest, a quarter of them before `SINCE`; one response carries `id`
 *   instead of `uuid`;
 * - 105 annotations (2 pages of 100), 7 feature flags, 3 experiments, and
 *   one annotation without `created_at` (dropped by a `since` read).
 */

export const PROJECT_ID = "41234";

function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const iso = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, ".000000Z");
const START = Date.UTC(2025, 5, 1);
const END = Date.UTC(2026, 10, 10);

function uuid(random) {
  const hex = () =>
    Math.floor(random() * 16)
      .toString(16)
      .toLowerCase();
  const part = n => Array.from({ length: n }, hex).join("");
  return `0190${part(4)}-${part(4)}-7${part(3)}-a${part(3)}-${part(12)}`;
}

const user = (id, first, email) => ({
  id,
  uuid: `0188aa00-0000-0000-0000-00000000000${id}`,
  distinct_id: `user_${id}`,
  first_name: first,
  last_name: "",
  email,
  is_email_verified: true,
  hedgehog_config: null,
  role_at_organization: "product",
});

const USERS = [
  user(1, "Ana", "ana@example.com"),
  user(2, "Marc", "marc@example.com"),
];

function survey(random, index, overrides = {}) {
  const created = START + Math.floor(random() * (END - START));
  const id = uuid(random);
  return {
    id,
    name: `Survey ${index + 1}: ${["NPS", "Valuation feedback", "Agent quality", "Pricing", "Onboarding", "Exit"][index % 6]}`,
    description: index % 2 ? "Asked after a valuation" : "",
    type: index % 3 === 0 ? "popover" : "api",
    schedule: "once",
    linked_flag: null,
    linked_flag_id: null,
    linked_insight_id: null,
    targeting_flag: null,
    internal_targeting_flag: {
      id: 900 + index,
      team_id: 1,
      key: `survey-targeting-${id.slice(0, 8)}`,
      active: true,
    },
    questions: [
      {
        id: uuid(random),
        type: "rating",
        scale: 10,
        display: "number",
        question: "How likely are you to recommend us?",
        lowerBoundLabel: "Unlikely",
        upperBoundLabel: "Very likely",
      },
      {
        id: uuid(random),
        type: "open",
        question: "What could we do better?",
        optional: true,
      },
    ],
    conditions:
      index % 2 ? { url: "/valuation", urlMatchType: "icontains" } : null,
    appearance: { position: "right", backgroundColor: "#eeeded" },
    created_at: iso(created),
    created_by: USERS[index % 2],
    start_date: iso(created + 3_600_000),
    end_date: null,
    archived: false,
    responses_limit: null,
    feature_flag_keys: [
      { key: "flag", value: null },
      {
        key: "internal_targeting_flag_key",
        value: `survey-targeting-${id.slice(0, 8)}`,
      },
    ],
    iteration_count: null,
    iteration_frequency_days: null,
    iteration_start_dates: [],
    current_iteration: null,
    current_iteration_start_date: null,
    response_sampling_start_date: null,
    response_sampling_interval_type: "week",
    response_sampling_interval: null,
    response_sampling_limit: null,
    response_sampling_daily_limits: null,
    enable_partial_responses: index % 2 === 0,
    enable_iframe_embedding: false,
    base_language: null,
    translations: null,
    user_access_level: "editor",
    form_content: null,
    ...overrides,
  };
}

function responses(random, count, surveyCreated) {
  const from = Date.parse(surveyCreated);
  const rows = [];
  for (let i = 0; i < count; i++) {
    const submitted = from + Math.floor(random() * (END - from));
    const row = {
      uuid: uuid(random),
      distinct_id: `ph_${Math.floor(random() * 1e9).toString(36)}`,
      session_id: random() < 0.8 ? uuid(random) : null,
      submitted_at: iso(submitted),
      answers: {
        $survey_response: Math.floor(random() * 11),
        $survey_response_1: random() < 0.4 ? "Faster answers please" : null,
      },
      extra: {
        $current_url: "https://realadvisor.example/valuation/result",
        $lib: "web",
        $survey_iteration: null,
      },
    };
    rows.push(row);
  }
  return rows;
}

function featureFlag(random, id) {
  const created = START + Math.floor(random() * (END - START));
  return {
    id,
    name: `Flag ${id}`,
    key: `flag-${id}`,
    filters: {
      groups: [{ variant: null, properties: [], rollout_percentage: 50 }],
      payloads: {},
      multivariate: null,
    },
    deleted: false,
    active: id % 3 !== 0,
    created_by: USERS[id % 2],
    created_at: iso(created),
    is_simple_flag: true,
    rollout_percentage: 50,
    ensure_experience_continuity: false,
    experiment_set: [],
    surveys: [],
    features: [],
    rollback_conditions: null,
    performed_rollback: false,
    can_edit: true,
    tags: [],
    usage_dashboard: 1000 + id,
    analytics_dashboards: [],
    has_enriched_analytics: false,
    user_access_level: "editor",
    status: "ACTIVE",
    version: 1,
    last_modified_by: USERS[(id + 1) % 2],
  };
}

function experiment(random, id) {
  const created = START + Math.floor(random() * (END - START));
  return {
    id,
    name: `Experiment ${id}`,
    description: "Price page layout",
    type: "web",
    start_date: iso(created + 86_400_000),
    end_date: id === 1 ? iso(created + 15 * 86_400_000) : null,
    feature_flag_key: `exp-${id}`,
    feature_flag: { id: 500 + id, key: `exp-${id}`, active: true },
    holdout: null,
    holdout_id: null,
    exposure_criteria: { filterTestAccounts: true },
    parameters: {
      feature_flag_variants: [
        { key: "control", rollout_percentage: 50 },
        { key: "test", rollout_percentage: 50 },
      ],
    },
    filters: {},
    metrics: [{ kind: "ExperimentMetric", metric_type: "funnel" }],
    metrics_secondary: [],
    secondary_metrics: [],
    saved_metrics: [],
    stats_config: { version: 2 },
    conclusion: id === 1 ? "won" : null,
    conclusion_comment: id === 1 ? "Test variant converts better" : null,
    archived: false,
    deleted: false,
    created_by: USERS[id % 2],
    created_at: iso(created),
    updated_at: iso(created + 2 * 86_400_000),
  };
}

function annotation(random, id) {
  const created = START + Math.floor(random() * (END - START));
  return {
    id,
    content: `Release ${id}`,
    date_marker: iso(created - 3_600_000),
    creation_type: id % 4 === 0 ? "GIT" : "USR",
    dashboard_item: null,
    dashboard_id: null,
    dashboard_name: null,
    insight_short_id: null,
    insight_name: null,
    insight_derived_name: null,
    created_by: USERS[id % 2],
    created_at: id === 42 ? null : iso(created),
    updated_at: iso(created + 60_000),
    deleted: false,
    scope: "project",
  };
}

export function buildDataset() {
  const random = rng(20261117);
  const surveys = Array.from({ length: 6 }, (_, i) =>
    survey(
      random,
      i,
      i === 4 ? { archived: true, end_date: iso(END - 86_400_000) } : {},
    ),
  );
  const counts = [230, 0, 3, 40, 12, 1];
  const surveyResponses = new Map();
  surveys.forEach((s, i) => {
    const rows = responses(random, counts[i], s.created_at);
    if (i === 5) {
      // An older payload shape: the event uuid as `id`.
      const { uuid: id, ...rest } = rows[0];
      rows[0] = { id, ...rest };
    }
    surveyResponses.set(s.id, rows);
  });
  return {
    lists: {
      surveys,
      feature_flags: Array.from({ length: 7 }, (_, i) =>
        featureFlag(random, i + 1),
      ),
      experiments: Array.from({ length: 3 }, (_, i) =>
        experiment(random, i + 1),
      ),
      annotations: Array.from({ length: 105 }, (_, i) =>
        annotation(random, i + 1),
      ),
    },
    surveyResponses,
  };
}
