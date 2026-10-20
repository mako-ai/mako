/**
 * Who an app belongs to, as a person of the workspace — the pure half.
 *
 * The apps index knows an app's owner two ways: its sharing state (or, for a
 * personal tree, the `users/<handle>/` mapping) gives a Mako user id, and git
 * gives the email its manifest was first committed with. That email is often
 * not the person's Mako address — a laptop's gmail, a GitHub noreply address
 * (`165400805+login@users.noreply.github.com`) — and showing its local part
 * on a card printed "rodriguezjoan" or "165400805+t-m-v" instead of a name.
 *
 * Resolution, first hit wins:
 *  1. the user id the app already has (state owner, personal tree owner);
 *  2. the author email matched to a workspace person: their Mako email, an
 *     email of a linked sign-in (Google/GitHub OAuth), a GitHub noreply
 *     address by the GitHub id of a linked GitHub sign-in (the id is in the
 *     address, or looked up from the login), and as a last resort the same
 *     local part on the workspace's own email domain — only when exactly
 *     one person has it, and never from a public mail domain (gmail and
 *     co. are nobody's in particular), so `rodriguezjoan@gmail.com` can
 *     never land on somebody else.
 *  3. unresolved: the email's local part, with a noreply address's numeric
 *     `<id>+` prefix dropped (the GitHub login is what a person recognises).
 */

/** What discovery and search return about an app's owner. */
export interface AppOwner {
  /** Set when the owner is a known Mako user. */
  userId?: string;
  /** The label to show: their name, else their handle, else the email's. */
  name: string;
  /** Their workspace handle (`users/<handle>/`), when they have one. */
  handle?: string;
  email?: string;
}

/** One person the workspace knows: a member, or a holder of a handle. */
export interface WorkspacePerson {
  userId: string;
  email: string;
  handle?: string;
  /** Display name, when the user model has one (it does not today). */
  name?: string;
  /** Numeric ids of linked GitHub sign-ins. */
  githubIds?: string[];
  /** Other addresses that are provably theirs (linked sign-in emails). */
  aliases?: string[];
}

const NOREPLY_DOMAIN = "users.noreply.github.com";

/**
 * Mail providers anyone can have an address at. Never a workspace's own
 * domain: a local-part match there would be a coincidence, not a person.
 */
const PUBLIC_MAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "gmx.com",
  "gmx.net",
  "gmx.de",
  "web.de",
  "yandex.com",
  "yandex.ru",
  "mail.ru",
  "fastmail.com",
  "hey.com",
  "zoho.com",
  NOREPLY_DOMAIN,
]);

export function isPublicMailDomain(domain: string): boolean {
  return PUBLIC_MAIL_DOMAINS.has(domain.toLowerCase());
}

function splitEmail(email: string): { local: string; domain: string } | null {
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return null;
  return {
    local: email.slice(0, at).toLowerCase(),
    domain: email.slice(at + 1).toLowerCase(),
  };
}

/**
 * A GitHub noreply address, parsed: `<id>+<login>@users.noreply.github.com`
 * (since 2017) or `<login>@users.noreply.github.com` (older accounts).
 */
export function parseGitHubNoreply(
  email: string,
): { id?: string; login: string } | null {
  const at = email.lastIndexOf("@");
  if (at <= 0) return null;
  if (email.slice(at + 1).toLowerCase() !== NOREPLY_DOMAIN) return null;
  const local = email.slice(0, at);
  const m = /^(?:(\d+)\+)?([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)$/.exec(
    local,
  );
  if (!m) return null;
  return m[1] ? { id: m[1], login: m[2] } : { login: m[2] };
}

/** What to show for an email nobody in the workspace has. */
export function emailOwnerLabel(email: string): string {
  const noreply = parseGitHubNoreply(email);
  if (noreply) return noreply.login;
  const local = email.split("@")[0] ?? "";
  // Any `<digits>+` prefix is an id, not a name.
  return local.replace(/^\d+\+/, "") || email;
}

/** The label for a known person: name, else handle, else their email's. */
export function personLabel(person: WorkspacePerson): string {
  return person.name?.trim() || person.handle || emailOwnerLabel(person.email);
}

export function ownerFromPerson(person: WorkspacePerson): AppOwner {
  return {
    userId: person.userId,
    name: personLabel(person),
    ...(person.handle ? { handle: person.handle } : {}),
    ...(person.email ? { email: person.email } : {}),
  };
}

/**
 * The workspace's own email domains: its auto-join domains when it lists
 * any, else the most common non-public domain among its people (a tie is
 * no answer). Public mail domains never qualify.
 */
export function workspaceEmailDomains(
  people: readonly WorkspacePerson[],
  autoJoinDomains: readonly string[] = [],
): string[] {
  const declared = autoJoinDomains
    .map(d => d.toLowerCase())
    .filter(d => d && !isPublicMailDomain(d));
  if (declared.length > 0) return [...new Set(declared)];
  const counts = new Map<string, number>();
  for (const p of people) {
    const domain = splitEmail(p.email)?.domain;
    if (!domain || isPublicMailDomain(domain)) continue;
    counts.set(domain, (counts.get(domain) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0) return [];
  if (ranked.length > 1 && ranked[0][1] === ranked[1][1]) return [];
  return [ranked[0][0]];
}

/**
 * The workspace's people, indexed for resolving an app's owner. Built once
 * per load (see app-owner.service.ts) and reused for every app.
 */
export class PeopleDirectory {
  private readonly byId = new Map<string, WorkspacePerson>();
  /** Address → the people it belongs to (more than one = ambiguous). */
  private readonly byEmail = new Map<string, Set<WorkspacePerson>>();
  private readonly byAlias = new Map<string, Set<WorkspacePerson>>();
  private readonly byGitHubId = new Map<string, Set<WorkspacePerson>>();
  /** Local part → people whose Mako email is on a workspace domain. */
  private readonly byDomainLocal = new Map<string, Set<WorkspacePerson>>();
  readonly domains: ReadonlySet<string>;

  constructor(
    people: readonly WorkspacePerson[],
    workspaceDomains: readonly string[] = [],
  ) {
    this.domains = new Set(workspaceDomains.map(d => d.toLowerCase()));
    const add = (
      map: Map<string, Set<WorkspacePerson>>,
      key: string,
      p: WorkspacePerson,
    ) => {
      const set = map.get(key) ?? new Set();
      set.add(p);
      map.set(key, set);
    };
    for (const p of people) {
      if (this.byId.has(p.userId)) continue;
      this.byId.set(p.userId, p);
      const email = p.email.toLowerCase();
      add(this.byEmail, email, p);
      for (const alias of p.aliases ?? []) {
        const a = alias.toLowerCase();
        if (a && a !== email) add(this.byAlias, a, p);
      }
      for (const id of p.githubIds ?? []) add(this.byGitHubId, id, p);
      const parts = splitEmail(email);
      if (parts && this.domains.has(parts.domain)) {
        add(this.byDomainLocal, parts.local.split("+")[0], p);
      }
    }
  }

  person(userId: string | undefined | null): WorkspacePerson | undefined {
    return userId ? this.byId.get(userId) : undefined;
  }

  /**
   * The one person an author email belongs to, or null. Every step
   * requires a single candidate: two people sharing an alias or a GitHub
   * account is a reason to show nobody, not to pick one.
   *
   * `githubIdOfLogin`: GitHub logins already looked up (for the old,
   * id-less noreply form).
   */
  resolveEmail(
    email: string | undefined | null,
    githubIdOfLogin?: ReadonlyMap<string, string>,
  ): WorkspacePerson | null {
    if (!email) return null;
    const e = email.trim().toLowerCase();
    const only = (set: Set<WorkspacePerson> | undefined) =>
      set && set.size === 1 ? [...set][0] : null;

    const exact = this.byEmail.get(e);
    if (exact) return only(exact);

    const noreply = parseGitHubNoreply(email);
    if (noreply) {
      const id =
        noreply.id ?? githubIdOfLogin?.get(noreply.login.toLowerCase());
      // A noreply address is GitHub's, not a mailbox: nothing else matches.
      return id ? only(this.byGitHubId.get(id)) : null;
    }

    const alias = this.byAlias.get(e);
    if (alias) return only(alias);

    // Last resort: `vadim@own-domain.example` → `vadim@<workspace domain>`.
    const parts = splitEmail(e);
    if (!parts || this.domains.size === 0) return null;
    if (this.domains.has(parts.domain)) return null; // that address is nobody's
    // `john@gmail.com` is whoever registered it first, not our `john@`.
    if (isPublicMailDomain(parts.domain)) return null;
    return only(this.byDomainLocal.get(parts.local.split("+")[0]));
  }

  /** Old-style noreply logins with no id in them that nobody matched yet. */
  loginsToLookUp(emails: Iterable<string | undefined>): string[] {
    const out = new Set<string>();
    for (const email of emails) {
      if (!email) continue;
      const noreply = parseGitHubNoreply(email);
      if (noreply && !noreply.id) out.add(noreply.login.toLowerCase());
    }
    return [...out];
  }

  get hasGitHubIdentities(): boolean {
    return this.byGitHubId.size > 0;
  }
}

/**
 * An app's owner: its user id when it has one (state owner or personal
 * tree), else whoever its author email resolves to, else the email itself
 * — labelled without a noreply prefix. Undefined when there is nothing.
 */
export function resolveAppOwner(
  input: {
    ownerId?: string;
    /** Email of the owner's account, when the directory may not have it. */
    ownerEmail?: string;
    ownerHandle?: string;
    authorEmail?: string;
  },
  people: PeopleDirectory,
  githubIdOfLogin?: ReadonlyMap<string, string>,
): AppOwner | undefined {
  if (input.ownerId) {
    const known = people.person(input.ownerId);
    if (known) return ownerFromPerson(known);
    if (input.ownerHandle || input.ownerEmail) {
      // A departed owner: still a Mako user, with what we know of them.
      return ownerFromPerson({
        userId: input.ownerId,
        email: input.ownerEmail ?? "",
        handle: input.ownerHandle,
      });
    }
  }
  if (input.authorEmail) {
    const person = people.resolveEmail(input.authorEmail, githubIdOfLogin);
    if (person) return ownerFromPerson(person);
    return { name: emailOwnerLabel(input.authorEmail) };
  }
  return undefined;
}
