import React, { useCallback, useEffect, useRef } from "react";
import type { ConsoleRef } from "../../Console";
import { useUIStore } from "../../../store/uiStore";

/**
 * One imperative handle per console tab, plus the window events that drive
 * those handles (realtime content, agent diffs) and the focus/active-content
 * sync when the active tab changes.
 */
export function useConsoleRefs(
  activeConsoleId: string | null,
  consoleTabCount: number,
) {
  const consoleRefs = useRef<
    Record<string, React.RefObject<ConsoleRef | null>>
  >({});

  // Created on first use (render included), so a newly opened tab's Console
  // attaches its handle on its very first mount.
  const getConsoleRef = useCallback((tabId: string) => {
    let ref = consoleRefs.current[tabId];
    if (!ref) {
      ref = React.createRef<ConsoleRef>();
      consoleRefs.current[tabId] = ref;
    }
    return ref;
  }, []);

  const dropConsoleRef = useCallback((tabId: string) => {
    delete consoleRefs.current[tabId];
  }, []);

  // Keep activeEditorContent in app store updated so Chat can use it
  const setActiveEditorContent = useUIStore(
    state => state.setActiveEditorContent,
  );

  // Update active editor content when tab focus changes AND focus the Monaco editor
  useEffect(() => {
    if (activeConsoleId && consoleRefs.current[activeConsoleId]?.current) {
      const consoleRef = consoleRefs.current[activeConsoleId].current;
      const content = consoleRef.getCurrentContent();
      setActiveEditorContent(content);

      // Focus the Monaco editor in the active console
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          consoleRef.focus();
        });
      });
    } else {
      setActiveEditorContent(undefined);
    }
  }, [activeConsoleId, consoleTabCount, setActiveEditorContent]);

  // NOTE: the legacy "console-modification" event (agent diff preview) is
  // gone — console tools execute server-side (issue #475) and edits arrive
  // through the realtime channel as "console-remote-content" below.

  // Realtime sync: push server-authoritative content into the mounted Monaco
  // editor (store content is updated by consoleStore/realtimeStore before
  // this event fires). setRemoteContent is quiet — no dirty flag, no
  // autosave echo, no focus steal.
  //
  // Agent (modify_console) edits arrive server-authoritative (issue #475) but
  // are surfaced as a reviewable Accept/Reject diff instead of replacing the
  // buffer silently. consoleStore.beginAgentReview dispatches
  // "console-agent-diff" with the proposed content; the editor keeps the
  // pre-agent baseline until resolved.
  useEffect(() => {
    const detailOf = (event: Event) =>
      (event as CustomEvent<{ consoleId: string; content: string }>).detail;
    const handleRemoteContent = (event: Event) => {
      const { consoleId, content } = detailOf(event);
      if (!consoleId) return;
      consoleRefs.current[consoleId]?.current?.setRemoteContent(content);
    };
    const handleAgentDiff = (event: Event) => {
      const { consoleId, content } = detailOf(event);
      if (!consoleId) return;
      consoleRefs.current[consoleId]?.current?.showRemoteDiff(content);
    };

    window.addEventListener("console-remote-content", handleRemoteContent);
    window.addEventListener("console-agent-diff", handleAgentDiff);
    return () => {
      window.removeEventListener("console-remote-content", handleRemoteContent);
      window.removeEventListener("console-agent-diff", handleAgentDiff);
    };
  }, []);

  return { getConsoleRef, dropConsoleRef, setActiveEditorContent };
}
