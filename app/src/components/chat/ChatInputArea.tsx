import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useOptionalWorkspace } from "../../contexts/workspace-context";
import { ArrowUp, LoaderCircle, Plus, Square, X } from "lucide-react";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "../ui/input-group";
import {
  Attachment,
  AttachmentMedia,
  AttachmentContent,
  AttachmentTitle,
  AttachmentActions,
  AttachmentAction,
  AttachmentTrigger,
} from "../ui/attachment";
import { Button } from "../ui/button";
import type { FileUIPart } from "ai";
import { ModelSelector } from "../ModelSelector";
import { SessionUsageBadge } from "./SessionUsageBadge";
import { useRenderCount, useWhyChanged } from "../../utils/renderDebug";
import { ImagePreviewDialog } from "./ImagePreviewDialog";
import type { QueuedPrompt } from "./QueuedPrompts";

// Isolated input component — owns its own `input` state so keystrokes
// never re-render the (expensive) message list above it.

interface ImageAttachment {
  id: string;
  file: File;
  previewUrl: string;
}

interface ChatInputAreaProps {
  onSubmit: (text: string, files?: FileUIPart[]) => void;
  onStop: () => void;
  isLoading: boolean;
  disabled: boolean;
  focusKey: string | number;
  paletteMode: "light" | "dark";
  editingPrompt: QueuedPrompt | null;
  onCancelEdit: () => void;
  /** A submitted plan is awaiting review — sent messages become plan
   * feedback (Cursor-style), so the placeholder reflects that. */
  planFeedbackMode?: boolean;
  /** Chat whose cumulative token/cost total is shown beside the model picker. */
  chatId: string;
  /** Selected model runs locally, so its turns are not metered. */
  isLocalAgent?: boolean;
  /** Overrides the default composer placeholder. */
  placeholder?: string;
  /** Text a screen wrote for this chat: replaces the composer's text. */
  draft?: { text: string; at: number } | null;
  /** Model picker and usage badge (off where the server picks the model). */
  showModelControls?: boolean;
  /** Image attachments (off where the server does not accept them). */
  allowAttachments?: boolean;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export const ChatInputArea = React.memo(
  ({
    onSubmit,
    onStop,
    isLoading,
    disabled,
    focusKey,
    paletteMode: _paletteMode,
    editingPrompt,
    onCancelEdit,
    planFeedbackMode = false,
    chatId,
    isLocalAgent = false,
    placeholder = "Ask Mako...",
    showModelControls = true,
    allowAttachments = true,
    draft,
  }: ChatInputAreaProps) => {
    const [input, setInput] = useState("");
    const [images, setImages] = useState<ImageAttachment[]>([]);
    const [previewSrc, setPreviewSrc] = useState<string | null>(null);
    const [isPreparingSubmission, setIsPreparingSubmission] = useState(false);
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const submissionRef = useRef(false);
    const [submissionError, setSubmissionError] = useState<string | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const imagesRef = useRef<ImageAttachment[]>([]);
    // When entering edit mode, load the queued prompt's text into the composer
    // and stash whatever the user was drafting so Cancel/commit can restore it.
    const inputValueRef = useRef(input);
    inputValueRef.current = input;
    const preEditDraftRef = useRef("");
    const prevEditingIdRef = useRef<string | null>(null);
    // Onboarding hands the user's "what do you want to build?" answer to
    // the composer through this key — their first prompt, where it belongs
    // (users used to type it into the workspace-name field).
    const currentWorkspace = useOptionalWorkspace()?.currentWorkspace;
    useEffect(() => {
      if (!currentWorkspace?.id) return;
      try {
        const key = `mako-chat-prefill:${currentWorkspace.id}`;
        const draft = localStorage.getItem(key);
        if (draft && !inputValueRef.current) {
          localStorage.removeItem(key);
          setInput(draft);
        }
      } catch {
        // Best effort.
      }
    }, [currentWorkspace?.id]);
    useRenderCount("ChatInputArea", {
      isLoading,
      disabled,
      imageCount: images.length,
    });
    useWhyChanged("ChatInputArea", {
      onSubmit,
      onStop,
      isLoading,
      disabled,
      focusKey,
      imageCount: images.length,
    });
    imagesRef.current = images;

    // Keep auto-sizing on browsers that do not support field-sizing: content.
    useLayoutEffect(() => {
      const textarea = inputRef.current;
      if (!textarea) return;
      textarea.style.height = "auto";
      textarea.style.height = `${textarea.scrollHeight}px`;
    }, [input]);

    useEffect(() => {
      const timer = setTimeout(() => inputRef.current?.focus(), 100);
      return () => clearTimeout(timer);
    }, [focusKey]);

    // A screen's draft ("Ask Mako to fix"): written in, for the person to
    // read, add to and send.
    useEffect(() => {
      if (draft) setInput(draft.text);
    }, [draft]);

    useEffect(() => {
      const prevId = prevEditingIdRef.current;
      const currId = editingPrompt?.id ?? null;
      if (currId === prevId) return;
      if (currId) {
        if (!prevId) preEditDraftRef.current = inputValueRef.current;
        setInput(editingPrompt?.text ?? "");
        setTimeout(() => inputRef.current?.focus(), 0);
      } else {
        setInput(preEditDraftRef.current);
        preEditDraftRef.current = "";
      }
      prevEditingIdRef.current = currId;
    }, [editingPrompt]);

    useEffect(() => {
      return () => {
        imagesRef.current.forEach(img => URL.revokeObjectURL(img.previewUrl));
      };
    }, []);

    const addImages = useCallback((files: File[]) => {
      const imageFiles = files.filter(f => f.type.startsWith("image/"));
      if (imageFiles.length === 0) return;
      setImages(prev => [
        ...prev,
        ...imageFiles.map(file => ({
          id: crypto.randomUUID(),
          file,
          previewUrl: URL.createObjectURL(file),
        })),
      ]);
    }, []);

    const removeImage = useCallback((id: string) => {
      setImages(prev => {
        const img = prev.find(i => i.id === id);
        if (img) URL.revokeObjectURL(img.previewUrl);
        return prev.filter(i => i.id !== id);
      });
    }, []);

    const handlePaste = useCallback(
      (e: React.ClipboardEvent) => {
        const items = e.clipboardData?.items;
        if (!items || !allowAttachments) return;
        const files: File[] = [];
        for (const item of items) {
          if (item.kind === "file" && item.type.startsWith("image/")) {
            const file = item.getAsFile();
            if (file) files.push(file);
          }
        }
        if (files.length > 0) {
          e.preventDefault();
          addImages(files);
        }
      },
      [addImages, allowAttachments],
    );

    const submitMessage = useCallback(async () => {
      const trimmedInput = input.trim();
      const currentImages = images;
      const hasText = trimmedInput.length > 0;
      const hasImages = currentImages.length > 0;
      if ((!hasText && !hasImages) || disabled || submissionRef.current) {
        return;
      }

      submissionRef.current = true;
      setIsPreparingSubmission(true);
      setSubmissionError(null);
      let fileParts: FileUIPart[] | undefined;
      try {
        if (hasImages) {
          fileParts = await Promise.all(
            currentImages.map(async img => ({
              type: "file" as const,
              url: await readFileAsDataUrl(img.file),
              mediaType: img.file.type,
            })),
          );
        }

        onSubmit(input, fileParts);
        currentImages.forEach(img => URL.revokeObjectURL(img.previewUrl));
        setInput("");
        setImages([]);
      } catch {
        setSubmissionError("Could not prepare the message. Try again.");
      } finally {
        submissionRef.current = false;
        setIsPreparingSubmission(false);
      }
    }, [images, input, disabled, onSubmit]);

    const hasContent = input.trim() || images.length > 0;
    const isSubmitDisabled = !hasContent || disabled || isPreparingSubmission;

    return (
      <form
        className="mx-4 my-2 min-w-0 text-foreground"
        aria-label="Chat composer"
        onSubmit={event => {
          event.preventDefault();
          void submitMessage();
        }}
        onPaste={isPreparingSubmission || disabled ? undefined : handlePaste}
      >
        <InputGroup
          className="rounded-2xl bg-background shadow-sm"
          data-disabled={disabled}
        >
          {editingPrompt && (
            <InputGroupAddon
              align="block-start"
              className="justify-between border-b"
            >
              <span className="text-xs">Editing queued message</span>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={onCancelEdit}
              >
                Cancel
              </Button>
            </InputGroupAddon>
          )}
          {images.length > 0 && (
            <InputGroupAddon align="block-start" className="flex-wrap gap-2">
              {images.map(img => (
                <Attachment key={img.id} size="sm" className="max-w-full">
                  <AttachmentMedia variant="image">
                    <img src={img.previewUrl} alt="" />
                  </AttachmentMedia>
                  <AttachmentContent>
                    <AttachmentTitle>{img.file.name}</AttachmentTitle>
                  </AttachmentContent>
                  <AttachmentTrigger
                    aria-label={`Preview ${img.file.name}`}
                    onClick={() => setPreviewSrc(img.previewUrl)}
                  />
                  <AttachmentActions>
                    <AttachmentAction
                      type="button"
                      aria-label={`Remove ${img.file.name}`}
                      disabled={isPreparingSubmission}
                      onClick={() => removeImage(img.id)}
                    >
                      <X />
                    </AttachmentAction>
                  </AttachmentActions>
                </Attachment>
              ))}
            </InputGroupAddon>
          )}
          <InputGroupTextarea
            ref={inputRef}
            aria-label="Message"
            autoFocus
            rows={1}
            readOnly={isPreparingSubmission}
            className="min-h-14 max-h-[min(45vh,24rem)] overflow-y-auto px-3 py-3 text-base sm:text-sm"
            placeholder={
              editingPrompt
                ? "Edit queued message..."
                : planFeedbackMode
                  ? "Suggest changes to the plan..."
                  : placeholder
            }
            value={input}
            onChange={event => setInput(event.target.value)}
            onKeyDown={event => {
              // IME confirmation is not a request to send (Safari also uses 229).
              if (event.nativeEvent.isComposing || event.keyCode === 229) {
                return;
              }
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void submitMessage();
              }
              if (event.key === "Escape" && editingPrompt) {
                event.preventDefault();
                onCancelEdit();
              }
              if (
                event.key === "Backspace" &&
                !input &&
                !isPreparingSubmission &&
                images.length > 0
              ) {
                event.preventDefault();
                const last = images[images.length - 1];
                if (last) removeImage(last.id);
              }
            }}
          />
          <InputGroupAddon align="block-end" className="gap-1.5">
            {allowAttachments && (
              <InputGroupButton
                variant="outline"
                size="icon-sm"
                className="rounded-full"
                aria-label="Attach image"
                title="Attach image"
                onClick={() => fileInputRef.current?.click()}
                disabled={isPreparingSubmission || disabled || isLoading}
              >
                <Plus />
              </InputGroupButton>
            )}
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
              {showModelControls && (
                <>
                  <ModelSelector />
                  <SessionUsageBadge
                    chatId={chatId}
                    isLocalAgent={isLocalAgent}
                  />
                </>
              )}
            </div>
            {(!isLoading || hasContent) && (
              <InputGroupButton
                type="submit"
                variant="default"
                size="icon-sm"
                className="rounded-full"
                aria-label={isLoading ? "Queue message" : "Send message"}
                title={isLoading ? "Queue message" : "Send message"}
                disabled={isSubmitDisabled}
              >
                {isPreparingSubmission ? (
                  <LoaderCircle className="motion-safe:animate-spin" />
                ) : (
                  <ArrowUp />
                )}
              </InputGroupButton>
            )}
            {isLoading && (
              <InputGroupButton
                variant="default"
                size="icon-sm"
                className="rounded-full"
                aria-label="Stop generating"
                title="Stop generating"
                onClick={onStop}
              >
                <Square className="size-3 fill-current" />
              </InputGroupButton>
            )}
          </InputGroupAddon>
        </InputGroup>
        {submissionError && (
          <p role="alert" className="mt-2 text-sm text-destructive">
            {submissionError}
          </p>
        )}
        <input
          ref={fileInputRef}
          type="file"
          aria-label="Image attachments"
          accept="image/*"
          multiple
          hidden
          disabled={
            !allowAttachments || disabled || isPreparingSubmission || isLoading
          }
          onChange={event => {
            if (event.target.files) {
              addImages(Array.from(event.target.files));
              event.target.value = "";
            }
          }}
        />
        <ImagePreviewDialog
          src={previewSrc}
          onClose={() => setPreviewSrc(null)}
        />
      </form>
    );
  },
);
ChatInputArea.displayName = "ChatInputArea";
