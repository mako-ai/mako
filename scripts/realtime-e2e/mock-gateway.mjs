/**
 * Deterministic mock of the Vercel AI Gateway for driving the REAL agent
 * pipeline with scripted tool calls (no LLM, no API key, fully repeatable).
 *
 * Speaks the @ai-sdk/gateway LanguageModelV3 protocol:
 *   POST /language-model  ->  SSE stream of LanguageModelV3StreamPart events.
 *
 * Activate by pointing the API at it (root .env):
 *   AI_GATEWAY_API_KEY=dummy-key-for-local-testing
 *   AI_GATEWAY_BASE_URL=http://localhost:9099
 *
 * Scripting: the last USER message may contain a directive:
 *   MOCKSCRIPT::[{"tool":"create_console","input":{...}},
 *                {"tool":"run_console","input":{"consoleId":"$prev.consoleId"}}]
 * Each gateway call (= one streamText step) emits the next unfinished script
 * entry as a tool-call; once every entry has a tool result in the prompt the
 * mock finishes with plain text. "$prev.consoleId" is substituted with the
 * most recent tool result's consoleId (lets create -> modify -> run chain).
 */
import http from "node:http";

const PORT = Number(process.env.MOCK_GATEWAY_PORT || 9099);

function sse(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

function lastUserDirective(prompt) {
  for (let i = prompt.length - 1; i >= 0; i--) {
    const m = prompt[i];
    if (m.role !== "user") continue;
    const text = (Array.isArray(m.content) ? m.content : [])
      .filter(p => p.type === "text")
      .map(p => p.text)
      .join("");
    const idx = text.indexOf("MOCKSCRIPT::");
    if (idx >= 0) {
      try {
        return {
          script: JSON.parse(text.slice(idx + "MOCKSCRIPT::".length)),
          userIndex: i,
        };
      } catch (e) {
        return { script: null, userIndex: i, parseError: String(e) };
      }
    }
    return { script: null, userIndex: i };
  }
  return { script: null, userIndex: -1 };
}

function countToolResultsAfter(prompt, userIndex) {
  let count = 0;
  let lastResultValue = null;
  for (let i = userIndex + 1; i < prompt.length; i++) {
    const m = prompt[i];
    if (m.role !== "tool") continue;
    for (const part of m.content || []) {
      if (part.type === "tool-result") {
        count++;
        const out = part.output;
        lastResultValue =
          out && typeof out === "object" && "value" in out ? out.value : out;
      }
    }
  }
  return { count, lastResultValue };
}

function substitute(input, lastResultValue) {
  const str = JSON.stringify(input);
  let consoleId = "";
  const scan = v => {
    if (!v || typeof v !== "object") return;
    if (typeof v.consoleId === "string") consoleId = v.consoleId;
    for (const k of Object.keys(v)) scan(v[k]);
  };
  scan(lastResultValue);
  return JSON.parse(str.replaceAll("$prev.consoleId", consoleId));
}

const server = http.createServer((req, res) => {
  if (req.method !== "POST" || !req.url.startsWith("/language-model")) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }
  let body = "";
  req.on("data", c => (body += c));
  req.on("end", () => {
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      res.writeHead(400).end("bad json");
      return;
    }
    const prompt = payload.prompt || [];
    const { script, userIndex, parseError } = lastUserDirective(prompt);
    const { count, lastResultValue } = countToolResultsAfter(prompt, userIndex);

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    sse(res, {
      type: "response-metadata",
      id: `mock-${Date.now()}`,
      modelId: "mock",
      timestamp: new Date().toISOString(),
    });

    const usage = {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, reasoning: 0 },
      raw: {},
    };

    const finishWithText = text => {
      sse(res, { type: "text-start", id: "t1" });
      sse(res, { type: "text-delta", id: "t1", delta: text });
      sse(res, { type: "text-end", id: "t1" });
      sse(res, { type: "finish", finishReason: "stop", usage });
      res.end();
    };

    if (parseError) {
      return finishWithText(`MOCK SCRIPT PARSE ERROR: ${parseError}`);
    }
    if (!script || !Array.isArray(script) || script.length === 0) {
      return finishWithText(
        "MOCK: no MOCKSCRIPT:: directive found; replying with text only.",
      );
    }
    if (count >= script.length) {
      return finishWithText(
        `MOCK DONE: executed ${script.length} scripted tool call(s).`,
      );
    }

    const step = script[count];
    const input = substitute(step.input || {}, lastResultValue);
    const toolCallId = `mocktc-${count}-${Date.now()}`;
    sse(res, { type: "tool-input-start", id: toolCallId, toolName: step.tool });
    sse(res, {
      type: "tool-input-delta",
      id: toolCallId,
      delta: JSON.stringify(input),
    });
    sse(res, { type: "tool-input-end", id: toolCallId });
    sse(res, {
      type: "tool-call",
      toolCallId,
      toolName: step.tool,
      input: JSON.stringify(input),
    });
    sse(res, { type: "finish", finishReason: "tool-calls", usage });
    res.end();
  });
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console -- standalone dev tool, not API code
  console.log(`mock AI gateway listening on :${PORT}`);
});
