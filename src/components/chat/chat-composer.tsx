"use client";

import * as React from "react";
import {
  ArrowUpIcon,
  CameraIcon,
  FileTextIcon,
  ClipboardPasteIcon,
  ImageIcon,
  MapPinIcon,
  XIcon,
  MicIcon,
  SquareIcon,
  StopCircleIcon,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { mockModes } from "@/data/mock";
import type { AiMode, ChatSharedLocation, ChatUserImageAttachment } from "@/types";
import { cn } from "@/lib/utils";
import { formatDuration } from "@/lib/speech";
import { LOCATION_UNAVAILABLE_COPY } from "@/lib/location";
import {
  CAMERA_IMAGE_MAX_BYTES,
  CAMERA_IMAGE_QUALITY,
  buildCameraAttachment,
  computeScaledDimensions,
  isCameraMimeSupported,
  isValidCapturedDataUrl,
  pasteImageErrorMessage,
  pastedImageName,
  pickClipboardImage,
  resolveSendPrompt,
  validatePastedImage,
} from "@/lib/camera";
import type { CameraCapturedImage } from "@/lib/camera";
import { useSpeechRecognition } from "@/hooks/use-speech-recognition";
import { useCamera } from "@/hooks/use-camera";
import { useGeolocation } from "@/hooks/use-geolocation";
import { AddContextMenu } from "./add-context-menu";
import { CameraDialog } from "./camera-dialog";

export interface AttachedSource {
  id: string;
  type: "document" | "pasted_text" | "image";
  name: string;
}

interface ChatComposerProps {
  disabled: boolean;
  streaming: boolean;
  mode: AiMode;
  onModeChange: (mode: AiMode) => void;
  /** Extended for Phase 7E: the camera photo (if any) rides alongside text. */
  onSend: (
    text: string,
    image?: ChatUserImageAttachment | null,
    /** Phase 7F — coarse location shared via the pin button (if any). */
    location?: ChatSharedLocation | null,
    /** Phase 8A — how the turn arrived: speech-to-text vs typed text. */
    inputModality?: "text" | "voice"
  ) => void;
  onStop: () => void;
  attachedSources?: AttachedSource[];
  onSourcesChange?: (sources: AttachedSource[]) => void;
}

function sourceIcon(type: AttachedSource["type"]) {
  switch (type) {
    case "document":
      return <FileTextIcon className="size-3" />;
    case "pasted_text":
      return <ClipboardPasteIcon className="size-3" />;
    case "image":
      return <ImageIcon className="size-3" />;
  }
}

// ---------------------------------------------------------------------------
// Phase 7E.1 — clipboard paste DOM glue. The decision logic (MIME/size/error
// copy) lives in src/lib/camera.ts as pure helpers; only the unavoidable
// DOM work (FileReader, <img> decode, canvas re-draw, toBlob) lives here. The
// pasted image is normalized to the exact `CameraCapturedImage` shape the
// camera capture produces, so it flows through the same attachment →
// `uploadedImage` → `validateSourceImage` pipeline with no second path.
// ---------------------------------------------------------------------------

type PasteStatus =
  | { state: "idle" }
  | { state: "processing" }
  | { state: "error"; message: string };

function getPastedImageFile(cd: DataTransfer): File | null {
  for (const item of Array.from(cd.items)) {
    if (item.kind === "file" && item.type.trim().toLowerCase().startsWith("image/")) {
      const file = item.getAsFile();
      if (file) return file;
    }
  }
  for (const file of Array.from(cd.files)) {
    if (file.type.trim().toLowerCase().startsWith("image/")) return file;
  }
  return null;
}

function readBlobAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(new Error("clipboard-read-failed"));
    reader.readAsDataURL(blob);
  });
}

function loadImageElement(dataUrl: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

interface RenderedPastedImage {
  blob: Blob;
  mimeType: string;
  width: number;
  height: number;
}

/**
 * Re-draws a decoded image on a canvas bounded to the camera dimension limit
 * (preserving aspect ratio), then encodes to the *declared* MIME when the
 * engine supports it (PNG keeps transparency; WebP is kept as WebP) and falls
 * back to JPEG otherwise. A transparent PNG screenshot therefore stays PNG.
 */
function renderPastedImage(
  img: HTMLImageElement,
  mimeType: string
): Promise<RenderedPastedImage | null> {
  const width = img.naturalWidth || img.width;
  const height = img.naturalHeight || img.height;
  const bounds = computeScaledDimensions(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = bounds.width;
  canvas.height = bounds.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return Promise.resolve(null);
  ctx.drawImage(img, 0, 0, bounds.width, bounds.height);
  const outputMimeType = isCameraMimeSupported(mimeType) ? mimeType : "image/jpeg";
  const quality = outputMimeType === "image/png" ? undefined : CAMERA_IMAGE_QUALITY;
  return new Promise((resolve) => {
    const finish = (blob: Blob | null, type: string) =>
      resolve(
        blob && blob.size > 0
          ? { blob, mimeType: type, width: bounds.width, height: bounds.height }
          : null
      );
    canvas.toBlob(
      (blob) => {
        if (blob && blob.size > 0) {
          finish(blob, outputMimeType);
        } else if (outputMimeType !== "image/jpeg") {
          // Some engines cannot encode a pasted copy as WebP; re-encode as JPEG.
          canvas.toBlob((fallback) => finish(fallback, "image/jpeg"), "image/jpeg", CAMERA_IMAGE_QUALITY);
        } else {
          finish(null, outputMimeType);
        }
      },
      outputMimeType,
      quality
    );
  });
}

export function ChatComposer({
  disabled,
  streaming,
  mode,
  onModeChange,
  onSend,
  onStop,
  attachedSources = [],
  onSourcesChange,
}: ChatComposerProps) {
  const [value, setValue] = React.useState("");
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  // Phase 8A — true while the current textarea value still came from a speech
  // transcript rather than a manual edit. Any real keystroke clears it.
  const voiceDerivedRef = React.useRef(false);

  // Phase 7E — camera button + capture attachment. Phase 7E.1 generalizes this
  // same attachment slot to clipboard pastes: a pasted image is normalized to
  // the identical `CameraCapturedImage` shape and replaces any current photo.
  const [image, setImage] = React.useState<CameraCapturedImage | null>(null);
  const [pasteStatus, setPasteStatus] = React.useState<PasteStatus>({ state: "idle" });
  const [cameraOpen, setCameraOpen] = React.useState(false);
  // The <video> element ref is owned here (the element owner mounts it via the
  // dialog) and passed into the hook so refs never surface in render output.
  const cameraVideoRef = React.useRef<HTMLVideoElement | null>(null);
  const camera = useCamera({ videoRef: cameraVideoRef });

  // Phase 7F — explicit, user-gesture-only location sharing. The pin button is
  // the ONLY trigger; the hook never probes geolocation on its own.
  const geolocation = useGeolocation();
  const [locationSupported, setLocationSupported] = React.useState(false);
  // Detect location support after hydration, deferred with a timer so the
  // initial client render matches the server shell (same pattern as useCamera).
  React.useEffect(() => {
    const id = window.setTimeout(() => {
      setLocationSupported(
        typeof navigator !== "undefined" && typeof navigator.geolocation !== "undefined"
      );
    }, 0);
    return () => window.clearTimeout(id);
  }, []);
  const sharedLocation =
    geolocation.state.status === "active" ? geolocation.state.location : null;

  const {
    isSupported: speechSupported,
    isListening,
    interimTranscript,
    error: speechError,
    start: startListening,
    stop: stopListening,
    abort: abortListening,
  } = useSpeechRecognition({
    onFinalTranscript: (text) => {
      // Append the final transcript to the editable textarea. Called from
      // within the recognition event handler (not effect body) so the user
      // can review/edit before sending — nothing is auto-sent.
      setValue((prev) => {
        const trimmed = prev.trimEnd();
        if (!trimmed) return text;
        return `${trimmed} ${text}`;
      });
      // Phase 8A — the appended transcript is voice-derived until the user
      // manually edits it.
      voiceDerivedRef.current = true;
    },
  });

  const [recordingSeconds, setRecordingSeconds] = React.useState(0);
  const recordingStartRef = React.useRef<number | null>(null);

  // Auto-grow the textarea up to a max height.
  React.useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [value]);

  // Drive the recording timer off an absolute start timestamp so we never
  // reset state synchronously in an effect. The timer bar is only rendered
  // while listening, so no explicit zero-reset is needed.
  React.useEffect(() => {
    if (isListening) {
      recordingStartRef.current = Date.now();
      const id = window.setInterval(() => {
        const start = recordingStartRef.current;
        if (start !== null) {
          setRecordingSeconds(Math.floor((Date.now() - start) / 1000));
        }
      }, 1000);
      return () => window.clearInterval(id);
    }
    recordingStartRef.current = null;
    return undefined;
  }, [isListening]);

  // Surface speech errors as toasts.
  React.useEffect(() => {
    if (speechError) {
      toast.error(speechError);
    }
  }, [speechError]);

  // Stop speech recognition on unmount to release the microphone.
  React.useEffect(() => {
    return () => {
      abortListening();
    };
  }, [abortListening]);

  const submit = () => {
    const trimmed = value.trim();
    // Phase 7E — a photo (camera or pasted) with no typed text defaults to
    // "Describe this image" (the send button unlocks whenever there is text OR
    // an attached photo).
    const effective = resolveSendPrompt(value, Boolean(image));
    if ((!effective && !trimmed) || disabled) return;
    const imageAttachment: ChatUserImageAttachment | undefined = image
      ? {
          dataUrl: image.dataUrl,
          mimeType: image.mimeType,
          name: image.name,
          width: image.width,
          height: image.height,
          fileSizeBytes: image.sizeBytes,
        }
      : undefined;
    onSend(effective, imageAttachment, sharedLocation, voiceDerivedRef.current ? "voice" : "text");
    setValue("");
    voiceDerivedRef.current = false;
    setImage(null);
    setPasteStatus({ state: "idle" });
  };

  const toggleLocation = () => {
    // User gesture required for the browser permission prompt (never remote).
    if (sharedLocation) {
      geolocation.clear();
    } else {
      geolocation.request();
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  const removeSource = (id: string) => {
    onSourcesChange?.(attachedSources.filter((s) => s.id !== id));
  };

  const handleSourcesSelected = (sources: AttachedSource[]) => {
    onSourcesChange?.([...attachedSources, ...sources]);
  };

  const toggleVoiceInput = () => {
    if (isListening) {
      stopListening();
    } else {
      startListening();
    }
  };

  const openCamera = () => {
    // Only ever opened from a user-interaction handler — never a remote
    // trigger — so the permission prompt is always user-initiated. getUserMedia
    // is called synchronously within this click gesture (not deferred into an
    // effect) to preserve the browser's user activation. Gated on camera
    // support so unsupported browsers stay silent.
    if (!camera.isSupported) return;
    camera.open();
    setCameraOpen(true);
  };

  const handleCameraPhoto = (photo: CameraCapturedImage) => {
    setImage(photo);
    setPasteStatus({ state: "idle" });
    textareaRef.current?.focus();
  };

  // Phase 7E.1 — clipboard image paste. Runs inside the user-interaction
  // handler so `getAsFile()` stays valid (browsers drop the clipboard blob if
  // read asynchronously). Text-only pastes are never intercepted; typed text
  // is never destroyed for image+text pastes (the image is attached, the text
  // stays in the textarea).
  const handlePaste = (event: React.ClipboardEvent<HTMLDivElement>) => {
    if (disabled || pasteStatus.state === "processing") return;
    const cd = event.clipboardData;
    if (!cd) return;
    const pick = pickClipboardImage(Array.from(cd.items), Array.from(cd.files));
    if (!pick.found) return; // clipboard holds no image → default paste proceeds
    event.preventDefault();
    if (!pick.supported) {
      setPasteStatus({ state: "error", message: pasteImageErrorMessage("unsupported-mime") });
      return;
    }
    const file = getPastedImageFile(cd);
    if (!file) {
      setPasteStatus({ state: "error", message: pasteImageErrorMessage("no-image") });
      return;
    }
    void normalizeAndAttachPaste(file);
  };

  const normalizeAndAttachPaste = async (file: File) => {
    setPasteStatus({ state: "processing" });
    try {
      const verdict = validatePastedImage({ mimeType: file.type, sizeBytes: file.size });
      if (!verdict.ok) {
        setPasteStatus({ state: "error", message: pasteImageErrorMessage(verdict.code) });
        return;
      }
      const dataUrl = await readBlobAsDataUrl(file);
      const img = await loadImageElement(dataUrl);
      if (!img) {
        setPasteStatus({ state: "error", message: pasteImageErrorMessage("processing-failed") });
        return;
      }
      const rendered = await renderPastedImage(img, file.type);
      if (!rendered) {
        setPasteStatus({ state: "error", message: pasteImageErrorMessage("processing-failed") });
        return;
      }
      if (rendered.blob.size > CAMERA_IMAGE_MAX_BYTES) {
        setPasteStatus({ state: "error", message: pasteImageErrorMessage("too-large") });
        return;
      }
      const outputDataUrl = await readBlobAsDataUrl(rendered.blob);
      if (!isValidCapturedDataUrl(outputDataUrl)) {
        setPasteStatus({ state: "error", message: pasteImageErrorMessage("processing-failed") });
        return;
      }
      const attachment = buildCameraAttachment({
        dataUrl: outputDataUrl,
        mimeType: rendered.mimeType,
        name: pastedImageName(file.name),
        width: rendered.width,
        height: rendered.height,
        sizeBytes: rendered.blob.size,
      });
      setImage(attachment);
      setPasteStatus({ state: "idle" });
    } catch {
      setPasteStatus({ state: "error", message: pasteImageErrorMessage("processing-failed") });
    }
  };

  return (
    <div className="shrink-0 px-3 pb-3 sm:px-6 sm:pb-4" onPaste={handlePaste}>
      <div className="mx-auto max-w-3xl">
        {/* Attached source chips */}
        {(attachedSources.length > 0 ||
          image ||
          sharedLocation ||
          pasteStatus.state === "processing" ||
          pasteStatus.state === "error" ||
          geolocation.state.status === "requesting" ||
          geolocation.state.status === "unavailable") && (
          <div className="mb-2 flex flex-wrap items-center gap-1.5 px-1">
            {attachedSources.map((source) => (
              <span
                key={source.id}
                className="inline-flex items-center gap-1 rounded-lg bg-primary/10 py-0.5 pr-1 pl-2 text-xs text-primary"
              >
                {sourceIcon(source.type)}
                <span className="max-w-[120px] truncate">{source.name}</span>
                <button
                  type="button"
                  onClick={() => removeSource(source.id)}
                  className="ml-0.5 rounded-full p-0.5 hover:bg-primary/20"
                  aria-label={`Remove ${source.name}`}
                >
                  <XIcon className="size-3" />
                </button>
              </span>
            ))}
            {pasteStatus.state === "processing" ? (
              <span className="inline-flex items-center rounded-lg bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                Adding image…
              </span>
            ) : null}
            {image ? (
              <span className="inline-flex items-center gap-1 rounded-lg bg-primary/10 py-0.5 pr-1 pl-1 text-xs text-primary">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={image.dataUrl}
                  alt=""
                  className="size-4 rounded"
                />
                <span className="max-w-[100px] truncate">{image.name}</span>
                <button
                  type="button"
                  onClick={() => {
                    setImage(null);
                    setPasteStatus({ state: "idle" });
                  }}
                  className="ml-0.5 rounded-full p-0.5 hover:bg-primary/20"
                  aria-label="Remove photo"
                >
                  <XIcon className="size-3" />
                </button>
              </span>
            ) : null}
            {sharedLocation ? (
              <span className="inline-flex items-center gap-1 rounded-lg bg-primary/10 py-0.5 pr-1 pl-2 text-xs text-primary">
                <MapPinIcon className="size-3" />
                <span>Location shared (approx.)</span>
                <button
                  type="button"
                  onClick={geolocation.clear}
                  className="ml-0.5 rounded-full p-0.5 hover:bg-primary/20"
                  aria-label="Remove shared location"
                >
                  <XIcon className="size-3" />
                </button>
              </span>
            ) : null}
            {geolocation.state.status === "requesting" ? (
              <span className="inline-flex items-center rounded-lg bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                Getting location…
              </span>
            ) : null}
            {pasteStatus.state === "error" ? (
              <p role="alert" className="w-full text-xs text-destructive">
                {pasteStatus.message}
              </p>
            ) : null}
            {geolocation.state.status === "unavailable" ? (
              <p role="alert" className="w-full text-xs text-destructive">
                {LOCATION_UNAVAILABLE_COPY}
              </p>
            ) : null}
          </div>
        )}

        <div
          className={cn(
            "rounded-2xl border bg-card p-2 shadow-sm transition-shadow focus-within:border-ring/60 focus-within:shadow-md",
            isListening && "border-red-400/60 dark:border-red-500/40"
          )}
          aria-label="Message composer"
        >
          {/* Recording indicator bar */}
          {isListening && (
            <div className="flex items-center gap-2 px-2 pb-1 pt-0.5">
              <span className="relative flex size-2 shrink-0">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-red-400 opacity-75" />
                <span className="relative inline-flex size-2 rounded-full bg-red-500" />
              </span>
              <span className="text-xs font-medium text-red-500 dark:text-red-400">
                Listening
              </span>
              <span className="font-mono text-[11px] text-muted-foreground">
                {formatDuration(recordingSeconds)}
              </span>
              {interimTranscript && (
                <span className="min-w-0 flex-1 truncate text-xs italic text-muted-foreground/60">
                  {interimTranscript}
                </span>
              )}
            </div>
          )}

          <Textarea
            ref={textareaRef}
            value={value}
            onChange={(event) => {
              // Phase 8A — a real keystroke invalidates any voice derivation.
              voiceDerivedRef.current = false;
              setValue(event.target.value);
            }}
            onKeyDown={handleKeyDown}
            placeholder={
              isListening
                ? "Speak now..."
                : disabled
                  ? "SathuX is thinking..."
                  : "Message SathuX..."
            }
            disabled={disabled}
            rows={1}
            className="max-h-[180px] resize-none border-0 bg-transparent px-2 py-2 shadow-none focus-visible:border-0 focus-visible:ring-0 dark:bg-transparent"
            aria-label="Message SathuX"
          />

          <div className="flex items-center gap-1 px-1 pt-1">
            {/* Add Context button */}
            {onSourcesChange && (
              <AddContextMenu onSourcesSelected={handleSourcesSelected} />
            )}

            {/* Mode selector — synced with the header control */}
            <div
              role="radiogroup"
              aria-label="AI mode"
              className="ml-1 hidden items-center rounded-lg bg-muted p-0.5 min-[420px]:flex"
            >
              {mockModes.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  role="radio"
                  aria-checked={mode === item.value}
                  onClick={() => onModeChange(item.value)}
                  className={cn(
                    "rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground",
                    mode === item.value &&
                      "bg-background text-foreground shadow-sm"
                  )}
                >
                  {item.label}
                </button>
              ))}
            </div>

            <div className="ml-auto flex items-center gap-1">
              <span className="mr-1 hidden text-[11px] text-muted-foreground/70 sm:block">
                Enter ↵ · Shift+Enter newline
              </span>

              {/* Camera input button (Phase 7E) — hydration-safe: only shown
                  once support is known on the client. */}
              {camera.isSupported ? (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground"
                  aria-label="Open camera"
                  disabled={disabled}
                  onClick={openCamera}
                >
                  <CameraIcon className="size-4" />
                </Button>
              ) : null}

              {/* Location pin button (Phase 7F) — explicit user gesture only;
                  never an automatic geolocation probe. */}
              {locationSupported ? (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className={
                    sharedLocation
                      ? "text-primary"
                      : "text-muted-foreground"
                  }
                  aria-label={
                    sharedLocation ? "Remove shared location" : "Share location"
                  }
                  title={
                    sharedLocation ? "Remove shared location" : "Share location"
                  }
                  disabled={disabled || geolocation.state.status === "requesting"}
                  onClick={toggleLocation}
                >
                  <MapPinIcon className="size-4" />
                </Button>
              ) : null}

              {/* Voice input button */}
              {speechSupported ? (
                isListening ? (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-red-500 hover:text-red-600 dark:text-red-400 dark:hover:text-red-500"
                    aria-label="Stop voice input"
                    onClick={toggleVoiceInput}
                  >
                    <StopCircleIcon className="size-4" />
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-muted-foreground"
                    aria-label="Start voice input"
                    disabled={disabled}
                    onClick={toggleVoiceInput}
                  >
                    <MicIcon />
                  </Button>
                )
              ) : null}

              {streaming ? (
                <Button size="icon-sm" aria-label="Stop generating" onClick={onStop}>
                  <SquareIcon className="size-3" fill="currentColor" />
                </Button>
              ) : (
                <Button
                  size="icon-sm"
                  aria-label="Send message"
                  disabled={(!value.trim() && !image && !sharedLocation) || disabled}
                  onClick={submit}
                >
                  <ArrowUpIcon />
                </Button>
              )}
            </div>
          </div>
        </div>
        <p className="mt-2 text-center text-[11px] text-muted-foreground/70">
          SathuX can make mistakes.
        </p>
      </div>

      <CameraDialog
        open={cameraOpen}
        onOpenChange={setCameraOpen}
        camera={camera}
        videoRef={cameraVideoRef}
        onPhoto={handleCameraPhoto}
      />
    </div>
  );
}
