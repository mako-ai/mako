/**
 * The AI-suggested commit comment for a console save: the diff between the
 * last saved state (the file at HEAD) and what is about to be saved.
 */
import { Types } from "mongoose";
import { SavedConsole } from "../../database/workspace-schema";
import { getLogger } from "../../logging";
import { savedConsoleStateFromRepo } from "../../apps/workspace-consoles.service";
import { generateVersionComment } from "../version-comment.service";

const logger = getLogger(["api", "consoles"]);

/** Longest content a comment is generated for. */
export const VERSION_COMMENT_MAX_CHARS = 50_000;

export async function consoleVersionComment(input: {
  workspaceId: string;
  consoleId: string;
  newContent: string;
  source: unknown;
  aiPrompt: unknown;
  user: { id: string; email?: string };
}) {
  const { workspaceId, consoleId, newContent } = input;
  let previousContent = "";
  let versionFound = false;
  if (Types.ObjectId.isValid(consoleId)) {
    const row = await SavedConsole.findOne({
      _id: new Types.ObjectId(consoleId),
      workspaceId: new Types.ObjectId(workspaceId),
    }).select("workspaceId path");
    const saved = row ? await savedConsoleStateFromRepo(row) : null;
    if (saved?.code) {
      previousContent = saved.code;
      versionFound = true;
    }
    logger.debug("Version comment baseline lookup", {
      consoleId,
      versionFound,
      previousContentLength: previousContent.length,
      newContentLength: newContent.length,
    });
  }

  const result = await generateVersionComment(
    {
      previousContent,
      newContent,
      language: "sql",
      source: input.source === "ai" ? "ai" : "user",
      aiPrompt: typeof input.aiPrompt === "string" ? input.aiPrompt : undefined,
    },
    { workspaceId, userId: input.user.id, userEmail: input.user.email },
  );

  return {
    comment: result.comment,
    diff: result.diff,
    debug: {
      consoleId,
      versionFound,
      previousContentLength: previousContent.length,
      newContentLength: newContent.length,
    },
  };
}
