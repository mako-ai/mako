import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Box,
  IconButton,
  Paper,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import { ArrowUp, ImagePlus, X } from "lucide-react";
import type { FileUIPart } from "ai";
import { ModelSelector } from "../ModelSelector";
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
  }: ChatInputAreaProps) => {
    const [input, setInput] = useState("");
    const [images, setImages] = useState<ImageAttachment[]>([]);
    const [previewSrc, setPreviewSrc] = useState<string | null>(null);
    const [isPreparingSubmission, setIsPreparingSubmission] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const imagesRef = useRef<ImageAttachment[]>([]);
    // When entering edit mode, load the queued prompt's text into the composer
    // and stash whatever the user was drafting so Cancel/commit can restore it.
    const inputValueRef = useRef(input);
    inputValueRef.current = input;
    const preEditDraftRef = useRef("");
    const prevEditingIdRef = useRef<string | null>(null);
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

    useEffect(() => {
      const timer = setTimeout(() => inputRef.current?.focus(), 100);
      return () => clearTimeout(timer);
    }, [focusKey]);

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
        if (!items) return;
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
      [addImages],
    );

    const submitMessage = useCallback(async () => {
      const trimmedInput = input.trim();
      const currentImages = images;
      const hasText = trimmedInput.length > 0;
      const hasImages = currentImages.length > 0;
      if ((!hasText && !hasImages) || isPreparingSubmission) {
        return;
      }

      setIsPreparingSubmission(true);
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
          currentImages.forEach(img => URL.revokeObjectURL(img.previewUrl));
        }

        onSubmit(input, fileParts);
        setInput("");
        setImages([]);
      } finally {
        setIsPreparingSubmission(false);
      }
    }, [images, input, isPreparingSubmission, onSubmit]);

    const hasContent = input.trim() || images.length > 0;
    const isSubmitDisabled = !hasContent || disabled || isPreparingSubmission;

    return (
      <Paper
        elevation={0}
        sx={{
          // Beautiful UI "Prompt Bar": hairline ring + soft card shadow that
          // strengthens on focus, instead of a plain divider border.
          border: "none",
          borderRadius: "14px",
          boxShadow: "var(--bui-shadow-card)",
          backgroundColor: "var(--bui-surface)",
          transition: "box-shadow 0.15s ease",
          "&:focus-within": {
            boxShadow:
              "0 0 0 1px var(--bui-line-strong), 0 1px 2px oklch(0% 0 0 / 0.06), 0 4px 12px oklch(0% 0 0 / 0.06)",
          },
          p: 1,
          my: 1,
          mx: 2,
          display: "flex",
          flexDirection: "column",
          gap: 1,
        }}
      >
        {editingPrompt && (
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              px: 0.5,
              pb: 0.5,
              mb: 0.5,
              borderBottom: 1,
              borderColor: "divider",
            }}
          >
            <Typography
              variant="caption"
              sx={{ fontWeight: 600, color: "text.secondary" }}
            >
              Editing queued message
            </Typography>
            <Typography
              component="button"
              type="button"
              onClick={onCancelEdit}
              variant="caption"
              sx={{
                border: "none",
                background: "none",
                cursor: "pointer",
                color: "primary.main",
                fontWeight: 600,
                p: 0,
                "&:hover": { textDecoration: "underline" },
              }}
            >
              Cancel
            </Typography>
          </Box>
        )}

        <form
          onSubmit={e => {
            e.preventDefault();
            submitMessage();
          }}
          onPaste={handlePaste}
        >
          {images.length > 0 && (
            <Box
              sx={{
                display: "flex",
                flexWrap: "wrap",
                gap: 1,
                px: 0.5,
                pt: 0.5,
              }}
            >
              {images.map(img => (
                <Box
                  key={img.id}
                  sx={{
                    position: "relative",
                    width: 56,
                    height: 56,
                    borderRadius: 1.5,
                    overflow: "hidden",
                    flexShrink: 0,
                    "&:hover .remove-btn": {
                      opacity: 1,
                    },
                  }}
                >
                  <Box
                    component="img"
                    src={img.previewUrl}
                    alt="Attachment"
                    onClick={() => setPreviewSrc(img.previewUrl)}
                    sx={{
                      width: 56,
                      height: 56,
                      borderRadius: 1.5,
                      objectFit: "cover",
                      cursor: "pointer",
                      border: 1,
                      borderColor: "divider",
                      display: "block",
                    }}
                  />
                  <IconButton
                    type="button"
                    className="remove-btn"
                    aria-label="Remove image"
                    onClick={e => {
                      e.stopPropagation();
                      removeImage(img.id);
                    }}
                    size="small"
                    disabled={isPreparingSubmission}
                    sx={{
                      position: "absolute",
                      top: 4,
                      right: 4,
                      width: 18,
                      height: 18,
                      p: 0,
                      opacity: 0,
                      transition: "opacity 0.15s",
                      color: "common.white",
                      backgroundColor: "rgba(0, 0, 0, 0.6)",
                      "&:hover": {
                        backgroundColor: "rgba(0, 0, 0, 0.8)",
                      },
                    }}
                  >
                    <X size={11} />
                  </IconButton>
                </Box>
              ))}
            </Box>
          )}

          <ImagePreviewDialog
            src={previewSrc}
            onClose={() => setPreviewSrc(null)}
          />

          <TextField
            fullWidth
            autoFocus
            multiline
            minRows={1}
            maxRows={24}
            placeholder={
              editingPrompt
                ? "Edit queued message..."
                : planFeedbackMode
                  ? "Suggest changes to the plan..."
                  : "Ask Chat..."
            }
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submitMessage();
              }
              if (e.key === "Escape" && editingPrompt) {
                e.preventDefault();
                onCancelEdit();
              }
              if (e.key === "Backspace" && !input && images.length > 0) {
                e.preventDefault();
                const last = images[images.length - 1];
                if (last) removeImage(last.id);
              }
            }}
            variant="outlined"
            inputRef={inputRef}
            sx={{
              m: 0.5,
              maxHeight: "60vh",
              overflowY: "auto",
              "& .MuiInputBase-input": {
                fontSize: { xs: 16, sm: 14 },
                "&::placeholder": {
                  color: "var(--bui-ink-3)",
                  opacity: 1,
                },
              },
              "& .MuiInputBase-root": {
                p: 0,
                fontSize: { xs: 16, sm: 14 },
              },
              "& .MuiOutlinedInput-notchedOutline": {
                border: "none",
              },
              "& .MuiOutlinedInput-root:hover .MuiOutlinedInput-notchedOutline":
                {
                  border: "none",
                },
              "& .MuiOutlinedInput-root.Mui-focused .MuiOutlinedInput-notchedOutline":
                {
                  border: "none",
                },
            }}
          />

          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            style={{ display: "none" }}
            onChange={e => {
              if (e.target.files) {
                addImages(Array.from(e.target.files));
                e.target.value = "";
              }
            }}
          />

          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              gap: 0.5,
              minWidth: 0,
            }}
          >
            <Box
              sx={{
                display: "flex",
                alignItems: "center",
                gap: 0.5,
                flex: "1 1 auto",
                minWidth: 0,
              }}
            >
              <ModelSelector />
            </Box>

            <Tooltip title="Attach image" placement="top">
              <IconButton
                type="button"
                onClick={() => fileInputRef.current?.click()}
                size="small"
                disabled={isPreparingSubmission || disabled || isLoading}
                sx={{
                  width: 28,
                  height: 28,
                  flexShrink: 0,
                  color: "var(--bui-ink-3)",
                  "&:hover": {
                    color: "var(--bui-ink)",
                    backgroundColor: "var(--bui-hover)",
                  },
                }}
              >
                <ImagePlus size={16} />
              </IconButton>
            </Tooltip>

            {isLoading ? (
              <IconButton
                type="button"
                aria-label="Stop generating"
                onClick={onStop}
                size="small"
                sx={{
                  width: 28,
                  height: 28,
                  borderRadius: "50%",
                  backgroundColor: "var(--bui-field)",
                  boxShadow: "var(--bui-shadow-hairline)",
                  "&:hover": {
                    backgroundColor: "var(--bui-hover-2)",
                  },
                  flexShrink: 0,
                }}
              >
                <Box
                  sx={{
                    width: 10,
                    height: 10,
                    backgroundColor: "var(--bui-ink)",
                    borderRadius: 0.5,
                  }}
                />
              </IconButton>
            ) : (
              <IconButton
                type="submit"
                aria-label="Send message"
                disabled={isSubmitDisabled}
                size="small"
                sx={{
                  width: 28,
                  height: 28,
                  borderRadius: "50%",
                  backgroundColor: !isSubmitDisabled
                    ? "var(--bui-accent)"
                    : "var(--bui-field)",
                  color: !isSubmitDisabled ? "#fff" : "var(--bui-ink-3)",
                  transition: "background-color 0.15s ease, transform 0.1s",
                  "&:hover": {
                    backgroundColor: !isSubmitDisabled
                      ? "var(--bui-accent-ink)"
                      : "var(--bui-field)",
                  },
                  "&:active": {
                    transform: !isSubmitDisabled ? "scale(0.94)" : "none",
                  },
                  "&.Mui-disabled": {
                    backgroundColor: "var(--bui-field)",
                    color: "var(--bui-ink-3)",
                  },
                  flexShrink: 0,
                }}
              >
                <ArrowUp size={18} />
              </IconButton>
            )}
          </Box>
        </form>
      </Paper>
    );
  },
);
ChatInputArea.displayName = "ChatInputArea";
