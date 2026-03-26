import { Db } from "mongodb";
import { loggers } from "../logging";

const log = loggers.migration();

export const description =
  "Create LlmUsage and ModelPricing collections with indexes, seed initial pricing data";

export async function up(db: Db): Promise<void> {
  const collections = await db.listCollections().toArray();
  const names = collections.map(c => c.name);

  // --- LlmUsage collection ---
  if (!names.includes("llmusages")) {
    await db.createCollection("llmusages");
    log.info("Created collection 'llmusages'");
  }

  const llmUsage = db.collection("llmusages");

  const llmIndexes: Array<{
    key: Record<string, 1 | -1>;
    name: string;
  }> = [
    { key: { workspaceId: 1, createdAt: -1 }, name: "ws_created" },
    { key: { userId: 1, createdAt: -1 }, name: "user_created" },
    { key: { chatId: 1 }, name: "chat" },
    {
      key: { workspaceId: 1, userId: 1, createdAt: -1 },
      name: "ws_user_created",
    },
  ];

  const existingLlmIdx = await llmUsage.indexes();
  for (const idx of llmIndexes) {
    const exists = existingLlmIdx.some(e => e.name === idx.name);
    if (!exists) {
      await llmUsage.createIndex(idx.key, {
        name: idx.name,
        background: true,
      });
      log.info(`Created index '${idx.name}' on llmusages`);
    }
  }

  // --- ModelPricing collection ---
  if (!names.includes("modelpricings")) {
    await db.createCollection("modelpricings");
    log.info("Created collection 'modelpricings'");
  }

  const pricing = db.collection("modelpricings");

  const pricingIdxName = "model_type_date";
  const existingPricingIdx = await pricing.indexes();
  if (!existingPricingIdx.some(e => e.name === pricingIdxName)) {
    await pricing.createIndex(
      { modelId: 1, tokenType: 1, effectiveFrom: -1 },
      { name: pricingIdxName, unique: true, background: true },
    );
    log.info(`Created index '${pricingIdxName}' on modelpricings`);
  }

  // --- Seed pricing data (prices per 1M tokens, USD) ---
  const now = new Date();

  const seedRows: Array<{
    modelId: string;
    tokenType: string;
    pricePerMillion: number;
  }> = [
    // OpenAI GPT-5.2
    { modelId: "openai/gpt-5.2", tokenType: "input", pricePerMillion: 2.5 },
    {
      modelId: "openai/gpt-5.2",
      tokenType: "cache_read",
      pricePerMillion: 1.25,
    },
    { modelId: "openai/gpt-5.2", tokenType: "output", pricePerMillion: 10 },
    // OpenAI GPT-5.2 Codex
    {
      modelId: "openai/gpt-5.2-codex",
      tokenType: "input",
      pricePerMillion: 2.5,
    },
    {
      modelId: "openai/gpt-5.2-codex",
      tokenType: "cache_read",
      pricePerMillion: 1.25,
    },
    {
      modelId: "openai/gpt-5.2-codex",
      tokenType: "output",
      pricePerMillion: 10,
    },
    // OpenAI GPT-4o
    { modelId: "openai/gpt-4o", tokenType: "input", pricePerMillion: 2.5 },
    {
      modelId: "openai/gpt-4o",
      tokenType: "cache_read",
      pricePerMillion: 1.25,
    },
    { modelId: "openai/gpt-4o", tokenType: "output", pricePerMillion: 10 },
    // OpenAI GPT-4o-mini (utility)
    {
      modelId: "openai/gpt-4o-mini",
      tokenType: "input",
      pricePerMillion: 0.15,
    },
    {
      modelId: "openai/gpt-4o-mini",
      tokenType: "cache_read",
      pricePerMillion: 0.075,
    },
    {
      modelId: "openai/gpt-4o-mini",
      tokenType: "output",
      pricePerMillion: 0.6,
    },
    // Anthropic Claude Opus 4.6
    {
      modelId: "anthropic/claude-opus-4-6",
      tokenType: "input",
      pricePerMillion: 15,
    },
    {
      modelId: "anthropic/claude-opus-4-6",
      tokenType: "cache_read",
      pricePerMillion: 1.5,
    },
    {
      modelId: "anthropic/claude-opus-4-6",
      tokenType: "cache_write",
      pricePerMillion: 18.75,
    },
    {
      modelId: "anthropic/claude-opus-4-6",
      tokenType: "output",
      pricePerMillion: 75,
    },
    // Anthropic Claude Opus 4.5
    {
      modelId: "anthropic/claude-opus-4-5",
      tokenType: "input",
      pricePerMillion: 15,
    },
    {
      modelId: "anthropic/claude-opus-4-5",
      tokenType: "cache_read",
      pricePerMillion: 1.5,
    },
    {
      modelId: "anthropic/claude-opus-4-5",
      tokenType: "cache_write",
      pricePerMillion: 18.75,
    },
    {
      modelId: "anthropic/claude-opus-4-5",
      tokenType: "output",
      pricePerMillion: 75,
    },
    // Anthropic Claude Sonnet 4.5
    {
      modelId: "anthropic/claude-sonnet-4-5",
      tokenType: "input",
      pricePerMillion: 3,
    },
    {
      modelId: "anthropic/claude-sonnet-4-5",
      tokenType: "cache_read",
      pricePerMillion: 0.3,
    },
    {
      modelId: "anthropic/claude-sonnet-4-5",
      tokenType: "cache_write",
      pricePerMillion: 3.75,
    },
    {
      modelId: "anthropic/claude-sonnet-4-5",
      tokenType: "output",
      pricePerMillion: 15,
    },
    // Anthropic Claude Haiku 4
    {
      modelId: "anthropic/claude-3-5-haiku-latest",
      tokenType: "input",
      pricePerMillion: 0.8,
    },
    {
      modelId: "anthropic/claude-3-5-haiku-latest",
      tokenType: "cache_read",
      pricePerMillion: 0.08,
    },
    {
      modelId: "anthropic/claude-3-5-haiku-latest",
      tokenType: "cache_write",
      pricePerMillion: 1,
    },
    {
      modelId: "anthropic/claude-3-5-haiku-latest",
      tokenType: "output",
      pricePerMillion: 4,
    },
    // Google Gemini 3 Pro Preview
    {
      modelId: "google/gemini-3-pro-preview",
      tokenType: "input",
      pricePerMillion: 1.25,
    },
    {
      modelId: "google/gemini-3-pro-preview",
      tokenType: "cache_read",
      pricePerMillion: 0.315,
    },
    {
      modelId: "google/gemini-3-pro-preview",
      tokenType: "output",
      pricePerMillion: 10,
    },
    // Google Gemini 2.5 Pro
    {
      modelId: "google/gemini-2.5-pro",
      tokenType: "input",
      pricePerMillion: 1.25,
    },
    {
      modelId: "google/gemini-2.5-pro",
      tokenType: "cache_read",
      pricePerMillion: 0.315,
    },
    {
      modelId: "google/gemini-2.5-pro",
      tokenType: "output",
      pricePerMillion: 10,
    },
    // Google Gemini 2.5 Flash
    {
      modelId: "google/gemini-2.5-flash",
      tokenType: "input",
      pricePerMillion: 0.15,
    },
    {
      modelId: "google/gemini-2.5-flash",
      tokenType: "cache_read",
      pricePerMillion: 0.0375,
    },
    {
      modelId: "google/gemini-2.5-flash",
      tokenType: "output",
      pricePerMillion: 0.6,
    },
  ];

  for (const row of seedRows) {
    const exists = await pricing.findOne({
      modelId: row.modelId,
      tokenType: row.tokenType,
    });
    if (!exists) {
      await pricing.insertOne({
        ...row,
        effectiveFrom: now,
        effectiveUntil: null,
      });
    }
  }

  log.info(`Seeded ${seedRows.length} pricing rows (skipped duplicates)`);
}
