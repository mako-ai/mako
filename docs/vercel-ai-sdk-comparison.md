# Mako vs Vercel AI SDK Best Practices Comparison

This document provides a comparison between Mako's AI implementation and Vercel's AI SDK recommended patterns and best practices.

**Current SDK Version**: `ai@6.0.0-beta.166`, `@ai-sdk/react@3.0.0-beta.169`

---

## Summary Statistics

| Category | Following Best Practice | Gap/Missing |
|----------|------------------------|-------------|
| Core Streaming | 8 | 4 |
| Data Model | 8 | 3 |
| Frontend/React | 7 | 7 |
| Tools & Agents | 7 | 5 |
| Providers & Models | 5 | 4 |
| Error Handling | 3 | 5 |
| Advanced Patterns | 2 | 9 |
| **Total** | **40** | **37** |

---

## Detailed Comparison

### Core Streaming Patterns

| Scope | Pattern/Library | Description | Status | Gap Details |
|-------|----------------|-------------|--------|-------------|
| API | `streamText()` | Core streaming function for text generation | ✅ Implemented | Using correctly in `agent.routes.ts` |
| API | `toUIMessageStreamResponse()` | Stream response format compatible with useChat | ✅ Implemented | Using with `originalMessages`, `sendReasoning`, `onFinish` |
| API | `convertToModelMessages()` | Convert UI messages to model format | ✅ Implemented | Using before streamText call |
| API | `generateText()` | Non-streaming text generation | ✅ Implemented | Used in title-generator.ts |
| API | `stepCountIs()` | Multi-step tool loop control | ✅ Implemented | MAX_STEPS=256 with proper logging |
| API | `onStepFinish` callback | Per-step callback for logging/control | ✅ Implemented | Logging step count and tool calls |
| API | `sendAutomaticallyWhen` | Auto-continue after tool results | ✅ Implemented | Using `lastAssistantMessageIsCompleteWithToolCalls` |
| API | `sendReasoning: true` | Forward reasoning tokens from models | ✅ Implemented | Enabled in toUIMessageStreamResponse |
| API | `streamObject()` | Streaming structured object generation | ❌ Missing | Not using for structured outputs (e.g., query results schema) |
| API | `generateObject()` | Non-streaming structured generation | ❌ Missing | Could use for schema-validated responses |
| API | `createDataStream()` | Custom data alongside text stream | ❌ Missing | Not using for metadata/progress |
| API | Stream merging (`mergeStreams`) | Combine multiple streams | ❌ Missing | Not combining streams for complex responses |

### Data Model & Persistence

| Scope | Pattern/Library | Description | Status | Gap Details |
|-------|----------------|-------------|--------|-------------|
| Data Model | Message parts array | Store messages as parts (text, tool, reasoning) | ✅ Implemented | Parts stored natively with legacy fallback for backward compatibility |
| Data Model | Frontend-owned chat IDs | Frontend generates chatId (MongoDB ObjectId) | ✅ Implemented | Using `generateObjectId()` on frontend, validated on backend |
| Data Model | Atomic save pattern | Save all messages once at stream end | ✅ Implemented | Using `saveChat()` in `onFinish` callback |
| Data Model | Tool call persistence | Store toolCallId, toolName, input, output | ✅ Implemented | Full tool call data stored in messages |
| Data Model | Reasoning token storage | Store reasoning/thinking blocks separately | ✅ Implemented | Extracted to `reasoning[]` array in schema |
| Data Model | UIMessage type preservation | Store native UIMessage format | ✅ Implemented | Native UIMessage parts array stored; legacy fields kept for backward compat |
| Data Model | SQL-based storage (Drizzle/Prisma) | Vercel recommends SQL with proper schemas | ❌ Different | Using MongoDB with Mongoose - works but different pattern |
| Data Model | Message versioning | Track message edits/regenerations | ❌ Missing | No version tracking for edited messages |
| Data Model | Conversation branching | Support for conversation branches/forks | ❌ Missing | Linear conversation only |
| Data Model | Attachment storage | Store file attachments with messages | ❌ Missing | No attachment support in schema |
| Data Model | Usage/token tracking | Store token counts per message | ✅ Implemented | Tracking promptTokens, completionTokens, totalTokens with per-turn history |

### Frontend/React Patterns

| Scope | Pattern/Library | Description | Status | Gap Details |
|-------|----------------|-------------|--------|-------------|
| Frontend | `useChat` hook | Primary chat hook with streaming | ✅ Implemented | Using with custom transport |
| Frontend | `DefaultChatTransport` | Custom transport with prepareSendMessagesRequest | ✅ Implemented | Sending workspace context dynamically |
| Frontend | `addToolOutput` | Provide client-side tool results | ✅ Implemented | Full client-side tool handling |
| Frontend | `onToolCall` callback | Handle client-side tools | ✅ Implemented | 5 client tools: read/modify/create console, list, set_connection |
| Frontend | `stop()` function | Cancel streaming | ✅ Implemented | Stop button with proper cleanup |
| Frontend | Message parts rendering | Render different part types | ✅ Implemented | Handling text, tool, reasoning parts |
| Frontend | `streamdown` package | Optimized markdown streaming | ✅ Implemented | Using `streamdown` with `@streamdown/code` in `StreamingMarkdown.tsx` |
| Frontend | `useCompletion` hook | Simple completion without chat history | ❌ Not needed | N/A - chat-focused use case |
| Frontend | `useObject` hook | Stream structured objects to UI | ❌ Missing | Not using for schema-validated UI updates |
| Frontend | `experimental_useAssistant` | OpenAI Assistants API integration | ❌ Missing | Not using OpenAI Assistants |
| Frontend | Image input handling | Send images in chat | ❌ Missing | No multimodal input support |
| Frontend | File attachment UI | Upload and display files | ❌ Missing | No file upload in chat |
| Frontend | Streaming text UI components | Animated text streaming | ⚠️ Basic | Using pulsing dot, not character-by-character |
| Frontend | Error boundary for AI errors | Catch and display AI-specific errors | ⚠️ Basic | Generic error display, not AI SDK error types |

### Tools & Agents

| Scope | Pattern/Library | Description | Status | Gap Details |
|-------|----------------|-------------|--------|-------------|
| Tools | Zod schema validation | Tool input schemas with zod | ✅ Implemented | All tools use zod schemas |
| Tools | Client-side tools (no execute) | Tools without execute for frontend handling | ✅ Implemented | Console tools properly defined |
| Tools | Server-side tools (with execute) | Tools with async execute functions | ✅ Implemented | Database tools with execute |
| Tools | Tool result truncation | Limit tool output size | ✅ Implemented | Custom truncation utilities |
| Tools | Dynamic tool registration | Register tools at runtime | ✅ Implemented | Tools created per-request with context |
| Tools | Tool namespacing | Prefix tools by category | ✅ Implemented | `mongo_*`, `sql_*` prefixes |
| Tools | Multi-step tool loops | Allow multiple tool calls | ✅ Implemented | stepCountIs(256) with logging |
| Tools | `maxToolRoundtrips` | Limit tool call rounds | ⚠️ Different | Using stepCountIs instead (similar purpose) |
| Tools | `toolChoice` parameter | Force/suggest specific tools | ❌ Missing | Not controlling tool selection |
| Tools | Tool middleware | Wrap tool execution with logging/metrics | ❌ Missing | No tool middleware layer |
| Tools | MCP (Model Context Protocol) | Connect to MCP servers | ❌ Missing | No MCP integration |
| Tools | `experimental_toToolResultContent` | Format complex tool results | ❌ Missing | Manual result formatting |

### Provider & Model Management

| Scope | Pattern/Library | Description | Status | Gap Details |
|-------|----------------|-------------|--------|-------------|
| Providers | Multi-provider support | OpenAI, Anthropic, Google | ✅ Implemented | All three providers configured |
| Providers | Provider SDKs | @ai-sdk/openai, anthropic, google | ✅ Implemented | Latest beta versions |
| Providers | Dynamic model selection | Switch models at runtime | ✅ Implemented | ModelSelector component, per-request model |
| Providers | API key validation | Check configured API keys | ✅ Implemented | `getConfiguredProviders()` utility |
| Providers | Model availability checking | Only show available models | ✅ Implemented | `getAvailableModels()` filters by API keys |
| Providers | Provider registry pattern | Centralized provider management | ❌ Missing | Manual switch statement for providers |
| Providers | `wrapLanguageModel` middleware | Add logging, caching, guardrails | ❌ Missing | No model middleware |
| Providers | Custom provider creation | Create custom AI providers | ❌ Missing | Only using official providers |
| Providers | Embedding models | Text embedding support | ❌ Missing | No embedding functionality |

### Error Handling & Resilience

| Scope | Pattern/Library | Description | Status | Gap Details |
|-------|----------------|-------------|--------|-------------|
| Errors | `onError` callback | Handle streaming errors | ✅ Implemented | useChat onError logs and displays |
| Errors | Error persistence | Save errors to chat for debugging | ✅ Implemented | `persistChatError()` service |
| Errors | Graceful degradation | Continue with partial response | ✅ Implemented | Partial tool calls saved |
| Errors | Orphan tool call sanitization | Remove tool_use without tool_result | ✅ Implemented | `sanitizeMessagesForModel()` in `api/src/utils/message-sanitizer.ts` |
| Errors | AI SDK error types | Use `AISDKError`, `APIError`, etc. | ❌ Missing | Not using typed errors |
| Errors | Retry logic with backoff | Automatic retry on transient failures | ❌ Missing | No retry layer for AI calls |
| Errors | Rate limit handling | Handle 429 errors gracefully | ❌ Missing | No specific rate limit handling |
| Errors | Timeout configuration | Set request timeouts | ❌ Missing | Using SDK defaults |

### Advanced Patterns & Features

| Scope | Pattern/Library | Description | Status | Gap Details |
|-------|----------------|-------------|--------|-------------|
| Advanced | Stream resumption | Resume interrupted streams | ❌ Missing | Streams restart from beginning |
| Advanced | Caching layer | Cache model responses | ❌ Missing | No response caching |
| Advanced | RAG integration | Retrieval-augmented generation | ❌ Missing | No vector search/embedding retrieval |
| Advanced | Telemetry/observability | Track AI usage metrics | ❌ Missing | No AI-specific telemetry |
| Advanced | Model middleware | Logging, guardrails, caching | ❌ Missing | No `wrapLanguageModel` usage |
| Advanced | Edge runtime support | Run on Edge/Workers | ❌ Missing | Node.js only |
| Advanced | Prompt caching (Anthropic) | Cache system prompts | ⚠️ Partial | Long system prompt but no explicit caching |
| Advanced | Function calling schemas | OpenAI function format | ✅ Implemented | Automatic via AI SDK |
| Advanced | Conversation summarization | Compress long conversations | ❌ Missing | Truncation only (last 10 messages) |
| Advanced | Semantic chunking | Smart context windowing | ❌ Missing | Simple message count limit |
| Advanced | A/B testing models | Compare model performance | ❌ Missing | No model comparison |

---

## Priority Recommendations

### High Priority (Significant UX/DX Impact)

1. **Stream resumption** - Critical for reliability. Users lose context when connection drops.

2. **Multimodal input** - Image input support is increasingly expected. AI SDK has native support.

3. **Reasoning parts display** - You have basic collapsible display, but could use Vercel's recommended progressive disclosure pattern with streaming support.

### Medium Priority (Better DX/Maintainability)

6. **Model middleware (`wrapLanguageModel`)** - Would enable logging, caching, and guardrails without modifying core logic.

7. **Provider registry** - Replace switch statement with registry pattern for cleaner provider management.

8. **`generateObject()` / `streamObject()`** - Useful for structured outputs like suggested queries, schema analysis.

9. **AI SDK error types** - Better error handling with typed errors (`APICallError`, `JSONParseError`, etc.).

10. **Retry logic** - Add exponential backoff for transient failures.

### Lower Priority (Nice to Have)

11. **Embeddings support** - For future RAG features.

12. **MCP integration** - For tool ecosystem expansion.

13. **Edge runtime** - For lower latency (requires significant refactoring).

14. **Prompt caching** - Cost optimization for Anthropic models.

15. **A/B testing** - For model comparison and optimization.

---

## Implementation Notes

### Current Architecture Strengths

1. **Clean separation** - agent-v2 folder with types, tools, prompts clearly organized
2. **Client-side tools** - Proper use of tools without execute for frontend handling
3. **Multi-database support** - Well-architected database abstraction
4. **Workspace context injection** - Smart truncation and dynamic context
5. **Title generation** - Fire-and-forget pattern doesn't block main stream
6. **Step limiting** - Proper runaway prevention with stepCountIs
7. **Native parts storage** - UIMessage parts stored directly for lossless round-trips

### Migration Considerations

1. **MongoDB to SQL** - Vercel examples use SQL. Migration would be significant but not required.

2. **Message format** - Now storing native UIMessage parts format with legacy fallback for old chats.

3. **Provider setup** - Current switch-based approach works but registry would be more extensible.

---

## Reference Links

- [AI SDK Documentation](https://sdk.vercel.ai/docs)
- [AI SDK GitHub](https://github.com/vercel/ai)
- [AI SDK Examples](https://github.com/vercel/ai/tree/main/examples)
- [Vercel AI Chatbot Template](https://github.com/vercel/ai-chatbot)
- [Streamdown Package](https://github.com/vercel/ai/tree/main/packages/streamdown)

---

## Appendix: Current Mako Implementation Files

| File | Purpose |
|------|---------|
| `api/src/routes/agent.routes.ts` | Main chat endpoint with streamText |
| `api/src/agent-v2/` | AI module with types, tools, prompts |
| `api/src/services/agent-thread.service.ts` | Chat persistence with saveChat (native parts storage) |
| `api/src/services/title-generator.ts` | AI title generation |
| `app/src/components/Chat.tsx` | Frontend chat UI with useChat |
| `app/src/components/StreamingMarkdown.tsx` | Optimized markdown streaming with streamdown |
| `api/src/database/workspace-schema.ts` | MongoDB schema including Chat model with IMessagePart |

---

*Generated: January 2026*
*AI SDK Version: 6.0.0-beta.166*
