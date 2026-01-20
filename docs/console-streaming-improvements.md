# Console Modification Streaming & Patching Improvements

This document analyzes the current console modification flow and proposes solutions to improve the user experience when the AI agent edits code in the console.

---

## Current Problems

### Problem 1: Modifications Appear All at Once

**User Experience Issue**: When the agent uses `modify_console` or `create_console`, users see:
1. A loading spinner on the tool call chip
2. No indication of what's being written
3. Suddenly, the full content appears in a diff view

**Root Cause Analysis**:

```
[LLM generates full content] 
    → [AI SDK receives complete tool input]
    → [onToolCall fires]
    → [Console updated all at once]
```

The AI SDK does stream tool call inputs (via `input-streaming` state), but we don't currently use this:

```typescript:225:237:app/src/components/Chat.tsx
interface ToolInvocationInfo {
  toolCallId: string;
  toolName: string;
  state:
    | "input-streaming"    // ← We have this state but don't use it!
    | "input-available"
    | "output-streaming"
    | "output-available"
    | "error";
  input?: unknown;
  output?: unknown;
}
```

The `onToolCall` callback only fires when the tool input is **complete** (`input-available`), not during streaming:

```typescript:571:574:app/src/components/Chat.tsx
    // Handle client-side tools (console operations)
    async onToolCall({ toolCall }) {
      // This only fires when input is complete!
```

### Problem 2: Agent Always Replaces Full Content

**User Experience Issue**: Even for small edits (e.g., changing a WHERE clause), the agent:
1. Sends the **entire** query content
2. Replaces everything, even unchanged lines
3. Creates large diffs that are hard to review

**Root Cause Analysis**:

The tool schema only offers three actions:

```typescript:20:34:api/src/agent-v2/tools/console-tools-client.ts
export const modifyConsoleSchema = z.object({
  action: z
    .enum(["replace", "insert", "append"])
    .describe("The type of modification to perform"),
  content: z.string().describe("The content to add or replace"),
  position: z
    .number()
    .nullable()
    .describe("Position for insert action (null for replace/append)"),
```

Problems with current actions:
- **replace**: Overwrites everything - no way to patch specific lines
- **insert**: Adds new content at a position - doesn't modify existing lines
- **append**: Adds to end - doesn't modify existing lines

**No "edit specific lines" or "search and replace" capability exists.**

---

## Proposed Solutions

### Solution 1: Stream Tool Input Content in Real-Time

**Concept**: Show characters appearing in the console as the LLM generates them, creating a "typing" effect.

**Implementation Approach**:

```typescript
// In Chat.tsx, watch for tool parts with state "input-streaming"
useEffect(() => {
  const lastMessage = messages[messages.length - 1];
  if (!lastMessage || lastMessage.role !== 'assistant') return;
  
  // Find streaming tool parts
  const streamingToolPart = lastMessage.parts?.find(p => {
    const type = p.type as string;
    return (type?.startsWith('tool-') || type === 'dynamic-tool') 
      && p.state === 'input-streaming';
  });
  
  if (streamingToolPart?.toolName === 'modify_console' || 
      streamingToolPart?.toolName === 'create_console') {
    // Stream partial content to console
    const partialContent = streamingToolPart.input?.content;
    if (partialContent) {
      streamToConsole(partialContent);
    }
  }
}, [messages]);
```

**Pros**:
- Real-time feedback - users see content as it's generated
- More engaging UX
- No changes to tool schema needed

**Cons**:
- Requires careful handling of partial content
- Console state management becomes complex
- May need to handle "undo" for streamed content

**Complexity**: Medium-High

---

### Solution 2: Add Patch/Edit Lines Action

**Concept**: Add a new tool action that allows editing specific line ranges instead of replacing everything.

**New Tool Schema**:

```typescript
export const modifyConsoleSchema = z.object({
  action: z
    .enum(["replace", "insert", "append", "patch"])
    .describe("The type of modification to perform"),
  content: z.string().describe("The content to add or replace"),
  position: z
    .number()
    .nullable()
    .describe("Position for insert action (null for replace/append)"),
  consoleId: z.string().describe("Target console ID"),
  // New fields for patch action
  startLine: z
    .number()
    .optional()
    .describe("Starting line for patch action (1-indexed)"),
  endLine: z
    .number()
    .optional()
    .describe("Ending line for patch action (1-indexed, inclusive)"),
});
```

**Prompt Update**:
```markdown
### Console Modification Actions

- **replace**: Replace the entire console content. Use for new queries or complete rewrites.
- **patch**: Replace specific lines (startLine to endLine) with new content. 
  Prefer this for small edits like modifying a WHERE clause or adding a column.
- **insert**: Insert content at a specific line without replacing existing content.
- **append**: Add content to the end of the console.

**Best Practice**: For modifications affecting <10 lines, use `patch` with specific line ranges.
```

**Implementation**:
```typescript
// In Chat.tsx onToolCall
case "patch": {
  if (!input.startLine || !input.endLine) {
    return { success: false, error: "startLine and endLine required for patch" };
  }
  
  const lines = currentContent.split("\n");
  const before = lines.slice(0, input.startLine - 1);
  const after = lines.slice(input.endLine);
  const newContent = [...before, input.content, ...after].join("\n");
  
  // Apply with focused diff showing only changed lines
  applyPatchWithFocusedDiff(consoleId, newContent, input.startLine, input.endLine);
}
```

**Pros**:
- Much smaller payloads for edits
- Cleaner diffs
- Faster LLM responses (less content to generate)
- Easier to review changes

**Cons**:
- Requires prompt engineering to encourage `patch` usage
- Agent needs to track line numbers accurately
- May fail if console content changed since last read

**Complexity**: Medium

---

### Solution 3: Search and Replace Pattern (Aider-style)

**Concept**: Instead of line numbers, use text matching - like Aider's SEARCH/REPLACE blocks.

**New Tool**:

```typescript
export const editConsoleSchema = z.object({
  consoleId: z.string(),
  edits: z.array(z.object({
    search: z.string().describe("Exact text to find (must match uniquely)"),
    replace: z.string().describe("Text to replace it with"),
  })).describe("Array of search/replace operations"),
});
```

**Example Agent Usage**:
```json
{
  "consoleId": "abc123",
  "edits": [
    {
      "search": "WHERE status = 'active'",
      "replace": "WHERE status = 'active' AND created_at > '2024-01-01'"
    }
  ]
}
```

**Pros**:
- Very token-efficient
- No line number tracking needed
- Robust to small formatting changes
- Clear what's changing

**Cons**:
- Search text must be unique
- Can fail if content was modified
- Harder for large changes spanning multiple blocks

**Complexity**: Medium

---

### Solution 4: Cursor-style Streaming Apply

**Concept**: Implement a streaming "apply" experience like Cursor IDE, where changes appear to be typed character-by-character with visual effects.

**Implementation**:

```typescript
// New hook: useStreamingApply
const useStreamingApply = (consoleId: string) => {
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamedContent, setStreamedContent] = useState("");
  
  const startStreamingApply = useCallback((targetContent: string) => {
    setIsStreaming(true);
    const currentContent = getConsoleContent(consoleId);
    
    // Calculate diff operations
    const operations = computeStreamingOperations(currentContent, targetContent);
    
    // Stream operations with visual delay
    let i = 0;
    const interval = setInterval(() => {
      if (i >= operations.length) {
        clearInterval(interval);
        setIsStreaming(false);
        return;
      }
      
      applyOperation(operations[i]);
      i++;
    }, 5); // 5ms per character for smooth animation
  }, [consoleId]);
  
  return { isStreaming, startStreamingApply };
};
```

**Visual Effects**:
- Cursor highlight showing insertion point
- Characters appear with slight delay
- Deleted text fades out
- Changed regions highlighted temporarily

**Pros**:
- Best visual experience
- Users see exactly what's changing
- Feels responsive even with large changes

**Cons**:
- Most complex to implement
- Requires significant UI work
- May need Monaco editor customization

**Complexity**: High

---

### Solution 5: Hybrid Approach (Recommended)

**Concept**: Combine multiple solutions for the best overall experience.

#### Phase 1: Quick Wins (1-2 days)

1. **Add `patch` action** with startLine/endLine
2. **Update prompt** to prefer `patch` for small edits
3. **Show streaming indicator** in console during tool generation

```typescript
// Console.tsx - add streaming overlay
{isAgentTyping && (
  <Box sx={{ 
    position: 'absolute', 
    bottom: 8, 
    right: 8,
    display: 'flex',
    alignItems: 'center',
    gap: 1 
  }}>
    <CircularProgress size={16} />
    <Typography variant="caption">AI is writing...</Typography>
  </Box>
)}
```

#### Phase 2: Enhanced Streaming (3-5 days)

1. **Stream partial tool content** to console as preview
2. **Highlight regions** that will change
3. **Show character count** of incoming content

```typescript
// Chat.tsx - stream to console preview
const streamingPart = findStreamingToolPart(messages);
if (streamingPart?.toolName === 'modify_console') {
  const partialContent = streamingPart.input?.content || '';
  showPreviewInConsole(streamingPart.input?.consoleId, partialContent);
}
```

#### Phase 3: Polish (Optional)

1. **Search/replace tool** for surgical edits
2. **Animated apply** for visual feedback
3. **Smart action selection** - auto-choose replace vs patch based on diff size

---

## Implementation Priority

| Solution | Impact | Effort | Priority |
|----------|--------|--------|----------|
| Add `patch` action | High | Low | 🔴 P0 |
| Streaming indicator in console | Medium | Low | 🔴 P0 |
| Update prompts for patch preference | High | Low | 🔴 P0 |
| Stream partial content preview | High | Medium | 🟡 P1 |
| Search/replace tool | Medium | Medium | 🟡 P1 |
| Animated apply effect | Low | High | 🟢 P2 |

---

## Technical Considerations

### AI SDK Capabilities

The AI SDK v6 provides tool streaming through message parts:

```typescript
// Message part types for tools:
type: "tool-{toolName}"  // Static tools
type: "dynamic-tool"     // Dynamic tools

// States during streaming:
state: "input-streaming"    // Input being generated
state: "input-available"    // Input complete, waiting for execution
state: "output-streaming"   // Output being generated  
state: "output-available"   // Execution complete
```

To access streaming input, watch the message parts array during streaming:

```typescript
useEffect(() => {
  if (status !== 'streaming') return;
  
  const lastMsg = messages[messages.length - 1];
  const toolParts = lastMsg?.parts?.filter(p => 
    p.type?.startsWith('tool-') && p.state === 'input-streaming'
  );
  
  // toolParts[n].input contains partial input as it streams
}, [messages, status]);
```

### Monaco Editor Integration

For streaming content updates:

```typescript
// Efficient incremental updates
editor.executeEdits('streaming', [{
  range: new monaco.Range(lastLine, lastCol, lastLine, lastCol),
  text: newCharacters,
  forceMoveMarkers: true
}]);

// For highlighting changed regions
const decoration = editor.deltaDecorations([], [{
  range: changedRange,
  options: {
    className: 'ai-change-highlight',
    isWholeLine: true
  }
}]);
```

### State Management

New store additions needed:

```typescript
// consoleStore.ts additions
interface ConsoleState {
  // ... existing fields
  streamingContent: Record<string, string>;  // consoleId -> partial content
  isAgentEditing: Record<string, boolean>;   // consoleId -> is AI editing
}

// Actions
setStreamingContent: (consoleId: string, content: string) => void;
setAgentEditing: (consoleId: string, editing: boolean) => void;
```

---

## Files to Modify

| File | Changes |
|------|---------|
| `api/src/agent-v2/tools/console-tools-client.ts` | Add `patch` action, startLine/endLine fields |
| `api/src/agent-v2/prompts/universal.ts` | Document `patch` action, encourage its use |
| `app/src/components/Chat.tsx` | Watch streaming tool parts, dispatch preview events |
| `app/src/components/Console.tsx` | Add streaming indicator, preview overlay |
| `app/src/components/Editor.tsx` | Handle streaming preview events |
| `app/src/store/consoleStore.ts` | Add streaming state management |
| `app/src/hooks/useMonacoConsole.ts` | Add streaming apply functionality |

---

## Success Metrics

After implementation, we should see:

1. **Reduced perceived latency**: Users see activity immediately instead of waiting
2. **Smaller diffs**: Patch operations change fewer lines
3. **Faster responses**: Less tokens generated = faster completion
4. **Better UX**: Real-time feedback makes the AI feel more responsive

---

## References

- [Cursor Apply Feature](https://cursor.sh/) - Inspiration for streaming apply
- [Aider SEARCH/REPLACE](https://aider.chat/docs/unified-diffs.html) - Text-based editing pattern
- [AI SDK Tool Streaming](https://sdk.vercel.ai/docs/ai-sdk-core/tools) - SDK documentation
- [Monaco Editor API](https://microsoft.github.io/monaco-editor/api/) - Editor integration

---

*Created: January 2026*
*Status: Analysis Complete - Ready for Implementation*
