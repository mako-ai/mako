/**
 * Renaming a workspace connector from the app: who may, and what to say
 * afterwards. A rename moves the folder `connectors/<slug>/` and the type
 * id `ws:<slug>`; the display name is `name` in the connector's code and
 * stays as it is.
 */

/**
 * Who the server lets rename a connector (api/src/rename/handlers/connector.ts):
 * a workspace editor. The server stays the judge; this saves the round trip.
 */
export function canRenameConnector(role: string | undefined): boolean {
  return role === "owner" || role === "admin" || role === "member";
}

export const CONNECTOR_RENAME_REFUSAL =
  "Only workspace editors (owner, admin or member) can rename a connector.";

/** What a rename changed and what it left alone, for the toast after it. */
export function connectorRenamedMessage(
  slug: string,
  displayName?: string,
): string {
  return (
    `The connector's folder is now connectors/${slug}/ and its type id ws:${slug}. ` +
    (displayName ? `Its display name "${displayName}" did not change: ` : "") +
    "the display name is `name` in the connector's code."
  );
}
