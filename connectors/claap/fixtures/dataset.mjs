/**
 * A synthetic Claap workspace and an emulator of the endpoints both
 * connectors call. No real data: every title, name and line is made up.
 *
 * - 23 recordings, oldest first. `rec_gone` answers 404 on its detail,
 *   `rec_noai` is Ready without `aiFields` on its detail: both are skipped.
 * - Transcripts: most recordings link a signed JSON per language
 *   (`https://signed.claap.test/...`). `rec_0003` has no link (the API
 *   endpoint serves it), `rec_0005`'s link answers 403 (the API endpoint
 *   serves it), `rec_0008`'s `de` transcript fails everywhere (a `failed`
 *   row), `rec_0010`'s is empty.
 * - The list carries no AI output; the detail does.
 */

export const SIGNED_ORIGIN = "https://signed.claap.test";

const iso = (day, hour = 9) =>
  new Date(Date.UTC(2026, 7, 1 + day, hour, 0, 0)).toISOString();

function segments(id, lang) {
  return [
    {
      startedAt: 1.2,
      endedAt: 4.8,
      text: `Bonjour, ici ${id} (${lang}).`,
      speaker: "speaker_1",
      words: [{ w: "Bonjour", s: 1.2 }],
    },
    {
      startedAt: 65,
      endedAt: 70.5,
      text: "Merci pour votre temps.",
      speaker: "speaker_2",
      languageCode: lang,
    },
    { startedAt: 3700, endedAt: 3702, text: "Au revoir." },
  ];
}

function recording(n) {
  const id =
    n === 6
      ? "rec_gone"
      : n === 11
        ? "rec_noai"
        : `rec_${String(n).padStart(4, "0")}`;
  const createdAt = iso(n * 3, 8 + (n % 6));
  const langs = n % 4 === 0 ? ["fr", "en"] : ["fr"];
  if (n === 8) langs.push("de");
  const transcripts = langs.map((lang, i) => ({
    langIso2: i === 0 ? lang.toUpperCase() : lang,
    isTranscript: i === 0,
    isActive: i === 0,
    ...(n === 3
      ? {}
      : { url: `${SIGNED_ORIGIN}/t/${id}/${lang}.json?sig=fixture${n}` }),
  }));
  const state = n === 17 ? "Uploaded" : "Ready";
  const detail = {
    id,
    title: `Visite ${n} - Rue Exemple`,
    state,
    source: n % 2 ? "meeting" : "upload",
    url: `https://app.claap.test/r/${id}`,
    thumbnailUrl: `https://cdn.claap.test/thumb/${id}.jpg`,
    createdAt,
    durationSeconds: 600 + n * 37.5,
    labels: n % 3 ? [] : [{ id: "lbl_1", name: "Estimation" }],
    channel: { id: "chn_1", name: "Ventes" },
    recorder: {
      id: "usr_1",
      name: "Agent One",
      email: "agent.one@example.test",
    },
    workspace: { id: "wks_fixture", name: "Fixture" },
    meeting: n % 2 ? { type: "external", startingAt: createdAt } : null,
    transcripts,
    video: { url: `https://cdn.claap.test/v/${id}.mp4` },
    actionItems: [{ text: `Envoyer l'estimation ${n}` }],
    companies: [],
    aiFields:
      state === "Ready" && n !== 11
        ? [{ name: "Résumé", value: `R${n}` }]
        : undefined,
    keyTakeaways: [`Point ${n}`],
    outlines: [{ title: "Intro", startedAt: 0 }],
  };
  if (detail.aiFields === undefined) delete detail.aiFields;
  return detail;
}

/** The list item: no AI output, no companies. */
function listItem(detail) {
  const {
    aiFields: _a,
    keyTakeaways: _k,
    outlines: _o,
    actionItems: _ai,
    companies: _c,
    ...rest
  } = detail;
  return rest;
}

export function buildDataset() {
  const recordings = Array.from({ length: 23 }, (_, i) => recording(i + 1));
  return {
    recordings,
    workspace: {
      id: "wks_fixture",
      name: "Fixture workspace",
      createdAt: "2025-01-15T10:00:00.000Z",
      membersCount: 12,
      recordingsCount: recordings.length,
    },
  };
}

const notFound = { status: 404, body: { error: { message: "Not found" } } };

/** Signed transcript links, served under `/signed/...` on the fixture server. */
export function emulateSigned(dataset, rawUrl) {
  const url = new URL(rawUrl, "http://claap.local");
  const match = /^\/signed\/t\/([^/]+)\/([a-z]+)\.json$/.exec(url.pathname);
  if (!match) return notFound;
  const [, id, lang] = match;
  if (id === "rec_0005") return { status: 403, body: "AccessDenied" };
  if (id === "rec_0008" && lang === "de") return { status: 410, body: "Gone" };
  if (id === "rec_0010") return { status: 200, body: { segments: [] } };
  return { status: 200, body: { segments: segments(id, lang) } };
}

/** Answer one API request, as Claap would. */
export function emulate(dataset, method, rawUrl) {
  if (method !== "GET") return notFound;
  const url = new URL(rawUrl, "http://claap.local");
  const q = Object.fromEntries(url.searchParams.entries());
  const route = url.pathname;

  if (route === "/v1/workspaces/mine") {
    return { status: 200, body: { result: { workspace: dataset.workspace } } };
  }
  if (route === "/v1/recordings") {
    let list = [...dataset.recordings].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
    if (q.createdAfter) list = list.filter(r => r.createdAt > q.createdAfter);
    const start = q.cursor ? Number(q.cursor.replace(/^cur_/, "")) : 0;
    const limit = Number(q.limit ?? 20);
    const page = list.slice(start, start + limit).map(listItem);
    const next =
      start + limit < list.length ? `cur_${start + limit}` : undefined;
    return {
      status: 200,
      body: {
        result: {
          recordings: page,
          pagination: {
            ...(next ? { nextCursor: next } : {}),
            totalCount: list.length,
          },
        },
      },
    };
  }
  const transcript = /^\/v1\/recordings\/([^/]+)\/transcript$/.exec(route);
  if (transcript) {
    const id = decodeURIComponent(transcript[1]);
    if (id === "rec_0008" && q.lang === "de") {
      return {
        status: 404,
        body: { error: { message: "No transcript in de" } },
      };
    }
    return {
      status: 200,
      body: { result: { transcript: { segments: segments(id, q.lang) } } },
    };
  }
  const detail = /^\/v1\/recordings\/([^/]+)$/.exec(route);
  if (detail) {
    const id = decodeURIComponent(detail[1]);
    if (id === "rec_gone") return notFound;
    const row = dataset.recordings.find(r => r.id === id);
    return row
      ? { status: 200, body: { result: { recording: row } } }
      : notFound;
  }
  return notFound;
}
