import { ObjectId } from "mongodb";
import { FAKE_GITHUB } from "./fake-services";
import { localTestDatabase } from "./local-database";

/**
 * CI does not automate GitHub's personal login. Bind the loopback fake
 * GitHub's App installation ONLY inside the disposable DB, to the
 * user/workspace created by this run. Mako's installation status, App JWT and
 * token minting, repository picker and link calls still run, against the fake
 * (tests/e2e/fake-services.ts). No real GitHub App or key is involved.
 */
export async function prepareGitHubInstallation(
  workspaceId: string,
  repo: string,
) {
  const client = localTestDatabase(); // Validate before contacting GitHub.
  if (
    process.env.MAKO_E2E_GITHUB_AUTH !== "fake" ||
    repo !== FAKE_GITHUB.repo
  ) {
    throw new Error("GitHub installation fixtures require the loopback fake.");
  }
  const email = process.env.MAKO_E2E_EMAIL;
  if (!email) throw new Error("The fresh E2E identity is required.");
  const { installationId } = FAKE_GITHUB;
  try {
    await client.connect();
    const db = client.db();
    const user = await db
      .collection<{
        _id: string;
        email: string;
        emailVerified: boolean;
      }>("users")
      .findOne({
        email: email.toLowerCase(),
        emailVerified: true,
      });
    const workspace =
      user &&
      (await db.collection("workspaces").findOne({
        _id: new ObjectId(workspaceId),
        createdBy: user._id,
        name: /^Mako E2E /,
      }));
    if (!user || !workspace)
      throw new Error(
        "Fixture requires this run's verified user and owned E2E workspace.",
      );
    await db.collection("github_installations").updateOne(
      { workspaceId: workspace._id, installationId },
      {
        $setOnInsert: {
          workspaceId: workspace._id,
          installationId,
          accountLogin: repo.split("/")[0],
          accountType: "Organization",
          repositorySelection: "selected",
          createdBy: user._id,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      },
      { upsert: true },
    );
  } finally {
    await client.close();
  }
}
