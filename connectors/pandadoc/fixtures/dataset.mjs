/**
 * A synthetic PandaDoc account and an emulator of the endpoints both
 * connectors call. No real data: every name, address and amount is made up.
 *
 * - 25 documents: the list returns a shallow projection, `/details` the rich
 *   object. Detail of `doc_nodetail_404` answers 404 and `doc_nodetail_400`
 *   400, so both sides keep the list projection.
 * - 12 templates, 5 contacts, 4 members (no `id`; `membership_id` stands in).
 * - Dates spread around the incremental anchor, 2026-09-01.
 */

const iso = (day, hour = 9) =>
  new Date(Date.UTC(2026, 7, 1 + day, hour, 0, 0)).toISOString();

const STATUSES = [
  "document.draft",
  "document.sent",
  "document.viewed",
  "document.completed",
  "document.declined",
];

/** The list projection of a document. */
export const DOCUMENT_LIST_FIELDS = [
  "id",
  "name",
  "status",
  "date_created",
  "date_modified",
  "expiration_date",
  "version",
];

function document(n) {
  const id =
    n === 7
      ? "doc_nodetail_404"
      : n === 13
        ? "doc_nodetail_400"
        : `doc_${String(n).padStart(4, "0")}AbCd`;
  const status = STATUSES[n % STATUSES.length];
  const created = iso(n * 2);
  const modified = iso(n * 2 + 1, 10 + (n % 5));
  const completed = status === "document.completed" ? iso(n * 2 + 1, 17) : null;
  return {
    id,
    name: `Mandate ${n} - Rue Exemple ${n}`,
    status,
    date_created: created,
    date_modified: modified,
    date_completed: completed,
    date_sent: status === "document.draft" ? null : iso(n * 2, 12),
    expiration_date: iso(n * 2 + 60),
    version: "2",
    autonumbering_sequence_name: n % 3 === 0 ? `MAND-${n}` : null,
    created_by: {
      id: "usr_fixture_1",
      email: "agent.one@example.test",
      first_name: "Agent",
      last_name: "One",
    },
    sent_by: status === "document.draft" ? null : { id: "usr_fixture_1" },
    template: { id: `tpl_${String(n % 4).padStart(4, "0")}`, name: "Mandate" },
    metadata: { property_id: `prop-${n}`, country: "fr" },
    tokens: [{ name: "Client.City", value: `Ville ${n}` }],
    fields: [{ uuid: `f-${n}`, name: "Signature", value: "" }],
    products: [],
    pricing: { tables: [], total: String(1000 + n * 10) },
    grand_total: { amount: String(1000 + n * 10), currency: "EUR" },
    tags: n % 2 ? ["mandate"] : [],
    recipients: [
      {
        id: `rcp-${n}`,
        email: `client${n}@example.test`,
        first_name: "Client",
        last_name: `N${n}`,
        has_completed: status === "document.completed",
      },
    ],
    linked_objects: [],
  };
}

function template(n) {
  return {
    id: `tpl_${String(n).padStart(4, "0")}`,
    name: `Template ${n}`,
    version: String(1 + (n % 3)),
    date_created: iso(n * 5),
    date_modified: iso(n * 5 + 3),
    content_date_modified: iso(n * 5 + 2),
  };
}

/** Template details: no `content_date_modified`, extra keys. */
function templateDetail(row) {
  const { content_date_modified: _c, ...rest } = row;
  return {
    ...rest,
    created_by: { id: "usr_fixture_1" },
    tokens: [],
    fields: [],
    roles: [{ name: "Client" }],
  };
}

export function buildDataset() {
  const documents = Array.from({ length: 25 }, (_, i) => document(i + 1));
  const templates = Array.from({ length: 12 }, (_, i) => template(i + 1));
  const contacts = Array.from({ length: 5 }, (_, i) => ({
    id: `contact_${i + 1}`,
    email: `contact${i + 1}@example.test`,
    first_name: "Contact",
    last_name: `N${i + 1}`,
    company: i % 2 ? "Example Realty" : "",
    job_title: "",
    phone: `+41 00 000 00 ${String(i).padStart(2, "0")}`,
    country: "CH",
    state: "",
    street_address: `Rue Exemple ${i + 1}`,
    city: "Genève",
    postal_code: "1200",
  }));
  const members = Array.from({ length: 4 }, (_, i) => ({
    user_id: `user_${i + 1}`,
    membership_id: `membership_${i + 1}`,
    email: `member${i + 1}@example.test`,
    first_name: "Member",
    last_name: `N${i + 1}`,
    is_active: i !== 3,
    workspace: "ws_fixture",
    workspace_name: "Fixture workspace",
    email_verified: true,
    role: i === 0 ? "Admin" : "Member",
    user_license: "Business",
    date_created: iso(i * 20),
    date_modified: i === 2 ? null : iso(i * 20 + 15),
  }));
  return { documents, templates, contacts, members };
}

const project = (row, fields) =>
  Object.fromEntries(fields.filter(f => f in row).map(f => [f, row[f]]));

const notFound = {
  status: 404,
  body: { type: "not_found", detail: "Not found." },
};

/**
 * Answer one request, as PandaDoc would. `count`/`page` paging; documents
 * ordered by `date_modified` and filtered by `modified_from`.
 */
export function emulate(dataset, method, rawUrl) {
  if (method !== "GET") return notFound;
  const url = new URL(rawUrl, "http://pandadoc.local");
  const query = Object.fromEntries(url.searchParams.entries());
  const route = url.pathname;
  const page = list => {
    const count = Number(query.count ?? 50);
    const pageNo = Number(query.page ?? 1);
    return {
      status: 200,
      body: { results: list.slice((pageNo - 1) * count, pageNo * count) },
    };
  };

  if (route === "/public/v1/documents") {
    let list = [...dataset.documents];
    if (query.order_by === "date_modified") {
      list.sort((a, b) => a.date_modified.localeCompare(b.date_modified));
    }
    if (query.modified_from) {
      list = list.filter(d => d.date_modified >= query.modified_from);
    }
    const response = page(list);
    response.body.results = response.body.results.map(d =>
      project(d, DOCUMENT_LIST_FIELDS),
    );
    return response;
  }
  const detail = /^\/public\/v1\/documents\/([^/]+)\/details$/.exec(route);
  if (detail) {
    const id = decodeURIComponent(detail[1]);
    if (id === "doc_nodetail_404") return notFound;
    if (id === "doc_nodetail_400") {
      return { status: 400, body: { type: "request_error", detail: "Bad." } };
    }
    const doc = dataset.documents.find(d => d.id === id);
    return doc ? { status: 200, body: { ...doc } } : notFound;
  }
  if (route === "/public/v1/templates") return page(dataset.templates);
  const tpl = /^\/public\/v1\/templates\/([^/]+)\/details$/.exec(route);
  if (tpl) {
    const row = dataset.templates.find(
      t => t.id === decodeURIComponent(tpl[1]),
    );
    return row ? { status: 200, body: templateDetail(row) } : notFound;
  }
  if (route === "/public/v1/contacts") {
    return { status: 200, body: { results: dataset.contacts } };
  }
  if (route === "/public/v1/members") {
    return { status: 200, body: { results: dataset.members } };
  }
  return notFound;
}
