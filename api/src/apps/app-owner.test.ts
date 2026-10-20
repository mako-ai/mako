/**
 * App owners as people: every way an author email maps to a workspace
 * member, and the matches it must refuse.
 *
 * Run: npx tsx src/apps/app-owner.test.ts
 */
import assert from "node:assert/strict";
import {
  PeopleDirectory,
  emailOwnerLabel,
  parseGitHubNoreply,
  resolveAppOwner,
  workspaceEmailDomains,
  type WorkspacePerson,
} from "./app-owner";

const joan: WorkspacePerson = {
  userId: "u-joan",
  email: "joan@realadvisor.com",
  handle: "joan",
  githubIds: ["10894843"],
  aliases: ["joan@realadvisor.com", "rodriguezjoan@gmail.com"],
};
const jonas: WorkspacePerson = {
  userId: "u-jonas",
  email: "jonas@realadvisor.com",
  handle: "jonas",
  githubIds: ["1095469"],
};
const vadim: WorkspacePerson = {
  userId: "u-vadim",
  email: "vadim@realadvisor.com",
  handle: "vadim",
};
const guillaume: WorkspacePerson = {
  userId: "u-guillaume",
  email: "guillaume.rouxel@realadvisor.com",
  handle: "guillaume.rouxel",
};
const named: WorkspacePerson = {
  userId: "u-named",
  email: "anna@realadvisor.com",
  handle: "anna",
  name: "Anna Whittlestone",
};
const people = [joan, jonas, vadim, guillaume, named];
const dir = new PeopleDirectory(people, ["realadvisor.com"]);

const resolve = (email: string, logins?: Map<string, string>) =>
  dir.resolveEmail(email, logins)?.userId ?? null;

// Noreply parsing ------------------------------------------------------------

assert.deepEqual(
  parseGitHubNoreply("165400805+t-m-v@users.noreply.github.com"),
  { id: "165400805", login: "t-m-v" },
);
assert.deepEqual(parseGitHubNoreply("wieseljonas@users.noreply.github.com"), {
  login: "wieseljonas",
});
assert.equal(parseGitHubNoreply("joan@realadvisor.com"), null);
assert.equal(parseGitHubNoreply("@users.noreply.github.com"), null);

// Labels for nobody: the login, never the numeric prefix ---------------------

assert.equal(
  emailOwnerLabel("165400805+t-m-v@users.noreply.github.com"),
  "t-m-v",
);
assert.equal(
  emailOwnerLabel("wieseljonas@users.noreply.github.com"),
  "wieseljonas",
);
assert.equal(emailOwnerLabel("rodriguezjoan@gmail.com"), "rodriguezjoan");

// 1. Exact Mako email (case-insensitive) -------------------------------------

assert.equal(resolve("Jonas@RealAdvisor.com"), "u-jonas");

// 2a. GitHub noreply with the id in it → linked GitHub sign-in ---------------

assert.equal(
  resolve("10894843+rodriguezjoan@users.noreply.github.com"),
  "u-joan",
);
// The id decides, not the login spelled in the address.
assert.equal(
  resolve("1095469+someone-else@users.noreply.github.com"),
  "u-jonas",
);
// Unknown id: nobody, and no fallback to the local part.
assert.equal(resolve("165400805+t-m-v@users.noreply.github.com"), null);

// 2b. Old-style noreply (login only) → id looked up → linked sign-in ---------

assert.equal(resolve("wieseljonas@users.noreply.github.com"), null);
assert.equal(
  resolve(
    "wieseljonas@users.noreply.github.com",
    new Map([["wieseljonas", "1095469"]]),
  ),
  "u-jonas",
);
assert.deepEqual(
  dir.loginsToLookUp([
    "WieselJonas@users.noreply.github.com",
    "1+x@users.noreply.github.com",
    "joan@realadvisor.com",
    undefined,
  ]),
  ["wieseljonas"],
);
// A noreply login that happens to be a member's handle is still not them.
assert.equal(resolve("vadim@users.noreply.github.com"), null);

// 3. A linked sign-in's email (alias) -----------------------------------------

assert.equal(resolve("rodriguezjoan@gmail.com"), "u-joan");

// 4. Last resort: same local part on the workspace's domain -------------------

assert.equal(resolve("vadim@mennanov.ru"), "u-vadim");
// …never from a public mail domain: gmail's `vadim` is not ours.
assert.equal(resolve("vadim@gmail.com"), null);
// …never a prefix or a near miss.
assert.equal(resolve("guillaume@mennanov.ru"), null);
assert.equal(resolve("jaime.devizcaya@gmail.com"), null);
// …and an address ON the workspace domain that nobody has is nobody's.
assert.equal(resolve("guillaume@realadvisor.com"), null);

// No false matches: ambiguity resolves to nobody ------------------------------

{
  const twins = new PeopleDirectory(
    [
      { userId: "a", email: "sam@acme.test", aliases: ["shared@ops.test"] },
      { userId: "b", email: "sam@acme.io", aliases: ["shared@ops.test"] },
      { userId: "c", email: "x@acme.test", githubIds: ["7"] },
      { userId: "d", email: "y@acme.test", githubIds: ["7"] },
    ],
    ["acme.test", "acme.io"],
  );
  // Two people share the alias: nobody.
  assert.equal(twins.resolveEmail("shared@ops.test"), null);
  // Two people have `sam@` on the workspace's domains: nobody.
  assert.equal(twins.resolveEmail("sam@home.example"), null);
  // Two accounts linked the same GitHub id: nobody.
  assert.equal(twins.resolveEmail("7+x@users.noreply.github.com"), null);
}
{
  // No workspace domain: no local-part matching at all.
  const open = new PeopleDirectory([vadim], []);
  assert.equal(open.resolveEmail("vadim@mennanov.ru"), null);
}

// Workspace domains -----------------------------------------------------------

assert.deepEqual(workspaceEmailDomains(people, ["RealAdvisor.com"]), [
  "realadvisor.com",
]);
// A public domain is never declared as the workspace's.
assert.deepEqual(workspaceEmailDomains([], ["gmail.com"]), []);
assert.deepEqual(workspaceEmailDomains(people), ["realadvisor.com"]);
assert.deepEqual(
  workspaceEmailDomains([
    { userId: "1", email: "a@gmail.com" },
    { userId: "2", email: "b@gmail.com" },
    { userId: "3", email: "c@acme.test" },
  ]),
  ["acme.test"],
);
// A tie between two company domains: no answer.
assert.deepEqual(
  workspaceEmailDomains([
    { userId: "1", email: "a@one.test" },
    { userId: "2", email: "b@two.test" },
  ]),
  [],
);

// resolveAppOwner: the app's own owner id wins --------------------------------

assert.deepEqual(
  resolveAppOwner(
    { ownerId: "u-jonas", authorEmail: "rodriguezjoan@gmail.com" },
    dir,
  ),
  {
    userId: "u-jonas",
    name: "jonas",
    handle: "jonas",
    email: "jonas@realadvisor.com",
  },
);
// The name field, when there is one, before the handle.
assert.equal(
  resolveAppOwner({ ownerId: "u-named" }, dir)?.name,
  "Anna Whittlestone",
);
// A departed owner (not in the directory) keeps their handle as the label.
assert.deepEqual(
  resolveAppOwner(
    { ownerId: "u-gone", ownerHandle: "maria", ownerEmail: "maria@x.test" },
    dir,
  ),
  { userId: "u-gone", name: "maria", handle: "maria", email: "maria@x.test" },
);
// An owner id we know nothing about falls through to the author email.
assert.equal(
  resolveAppOwner(
    { ownerId: "u-unknown", authorEmail: "jonas@realadvisor.com" },
    dir,
  )?.userId,
  "u-jonas",
);
// Unresolved author: a label only, no user id, no numeric prefix.
assert.deepEqual(
  resolveAppOwner(
    { authorEmail: "165400805+t-m-v@users.noreply.github.com" },
    dir,
  ),
  { name: "t-m-v" },
);
assert.equal(resolveAppOwner({}, dir), undefined);

console.info("app-owner: ok");
