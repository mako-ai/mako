import * as crypto from "crypto";

const FLOW_TOKEN_LENGTH = 12;

function camelToSnake(str: string): string {
  return str.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

function baseEntityTableName(baseName: string, entity: string): string {
  const normalized = entity.includes(":")
    ? `${camelToSnake(entity.split(":")[1])}_${entity.split(":")[0]}`
    : entity;
  return baseName ? `${baseName}_${normalized}` : normalized;
}

export function cdcFlowToken(flowId: string): string {
  const normalized = String(flowId || "")
    .trim()
    .toLowerCase();
  const alnum = normalized.replace(/[^a-z0-9]/g, "");

  if (alnum.length >= FLOW_TOKEN_LENGTH) {
    return `f${alnum.slice(-FLOW_TOKEN_LENGTH)}`;
  }

  const hash = crypto.createHash("sha1").update(normalized).digest("hex");
  return `f${(alnum + hash).slice(0, FLOW_TOKEN_LENGTH)}`;
}

export function cdcLiveTableName(
  basePrefix: string | undefined,
  entity: string,
  _flowId?: string,
): string {
  return baseEntityTableName(basePrefix || "", entity);
}

export function cdcStageTableName(
  basePrefix: string | undefined,
  entity: string,
  flowId: string,
): string {
  const liveTable = cdcLiveTableName(basePrefix, entity);
  return `${liveTable}__${cdcFlowToken(flowId)}__stage_changes`;
}
