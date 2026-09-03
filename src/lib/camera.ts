// ---------------------------------------------------------------------------
// Phase 7E — Camera Understanding (client helpers).
//
// PURE browser-safe helpers for camera capture. Every export here is safe to
// import in a Node test runner: no browser global is touched at module scope,
// and browser/database APIs are only ever accessed inside functions (which the
// React hook calls after mount / user interaction).
//
// Camera is an INPUT MODALITY, not a new query route: the captured image rides
// the existing /api/chat `uploadedImage` field and the existing Gemini
// multimodal pipeline. Nothing here uploads image data to Tavily or any other
// provider, and none of these functions log image bytes.
// ---------------------------------------------------------------------------

/** Bounded maximum dimension for camera frames sent to Gemini. */
export const CAMERA_IMAGE_MAX_DIMENSION = 1600;

/** JPEG export quality for normalized camera frames. */
export const CAMERA_IMAGE_QUALITY = 0.85;

/** Hard byte ceiling for a normalized camera JPEG. */
export const CAMERA_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

/** MIME types the camera path accepts (capture always exports JPEG, but PNG
 *  and WebP are allowed so a capture pipeline can stay forward compatible). */
const SUPPORTED_CAMERA_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

/** MIME types that are explicitly NOT accepted as camera input. */
const REJECTED_CAMERA_MIME_TYPES = new Set(["image/gif", "image/svg+xml"]);

/** Default prompt used when the user sends a photo without typing text. */
export const DEFAULT_CAMERA_PROMPT = "Describe this image.";

// ---------------------------------------------------------------------------
// Camera error taxonomy (friendly, never raw browser exceptions)
// ---------------------------------------------------------------------------

export type CameraErrorCode =
  | "not-supported"
  | "permission-denied"
  | "no-camera"
  | "insecure-context"
  | "start-failed"
  | "unknown";

const CAMERA_ERROR_MESSAGES: Record<CameraErrorCode, string> = {
  "not-supported": "Your browser doesn't support camera access.",
  "permission-denied": "Camera permission was denied.",
  "no-camera": "No camera is available on this device.",
  "insecure-context": "Camera access requires HTTPS or localhost.",
  "start-failed": "Unable to start the camera.",
  unknown: "The camera could not be started. Please try again.",
};

export function cameraErrorMessage(code: CameraErrorCode): string {
  return CAMERA_ERROR_MESSAGES[code] ?? CAMERA_ERROR_MESSAGES.unknown;
}

/**
 * Classifies a raw error (DOMException or similar) into a friendly code.
 * Reads `err.name` so it works with both real DOMExceptions and mocks.
 */
export function mapCameraError(error: unknown): CameraErrorCode {
  if (!error || typeof error !== "object") return "unknown";
  const name = (error as { name?: unknown }).name;

  if (name === "NotAllowedError" || name === "PermissionDeniedError") {
    return "permission-denied";
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return "no-camera";
  }
  if (name === "SecurityError" || name === "InsecureContextError") {
    return "insecure-context";
  }
  if (
    name === "NotReadableError" ||
    name === "TrackStartError" ||
    name === "OverconstrainedError" ||
    name === "AbortError"
  ) {
    return "start-failed";
  }
  // A TypeError is not a camera-classification name, but the most common
  // source here is an uninvokable/Illegal-invocation getUserMedia call or a
  // constraint build failure — both are start failures, never "unknown".
  if (name === "TypeError") {
    return "start-failed";
  }
  return "unknown";
}

// ---------------------------------------------------------------------------
// Capability detection (pure — takes the provider so tests pass a fake)
// ---------------------------------------------------------------------------

/**
 * Reports whether camera capture is supported. `getUserMedia` is resolved
 * lazily by the caller; passing `undefined` (the common SSR / node case)
 * reports `false` without ever touching a browser global.
 */
export function cameraSupported(
  getUserMedia: unknown = typeof navigator !== "undefined"
    ? navigator.mediaDevices?.getUserMedia
    : undefined
): boolean {
  return typeof getUserMedia === "function";
}

// ---------------------------------------------------------------------------
// MIME + size validation (camera image policy)
// ---------------------------------------------------------------------------

/**
 * Accepts a MIME type for the camera path only if it is a supported raster
 * image type. The filename extension is never trusted — the server re-checks
 * magic bytes via the existing `validateImage` pipeline.
 */
export function isCameraMimeSupported(mimeType: string): boolean {
  const mime = (mimeType ?? "").trim().toLowerCase();
  if (!mime) return false;
  if (REJECTED_CAMERA_MIME_TYPES.has(mime)) return false;
  if (!mime.startsWith("image/")) return false;
  return SUPPORTED_CAMERA_MIME_TYPES.has(mime);
}

/** Bounded size check for a camera image payload (normalized JPEG). */
export function isCameraImageWithinSize(bytes: number): boolean {
  return Number.isFinite(bytes) && bytes > 0 && bytes <= CAMERA_IMAGE_MAX_BYTES;
}

// ---------------------------------------------------------------------------
// Image normalization rules (scaling math — pure and testable)
// ---------------------------------------------------------------------------

export interface ScaledDimensions {
  width: number;
  height: number;
}

/**
 * Computes the target draw size for a capture so the longest edge is at most
 * `maxDim`, preserving aspect ratio. Returns the original size when no scaling
 * is needed. Non-positive inputs clamp to 1×1 to avoid zero-size canvases.
 */
export function computeScaledDimensions(
  width: number,
  height: number,
  maxDim: number = CAMERA_IMAGE_MAX_DIMENSION
): ScaledDimensions {
  const w = Math.max(1, Math.trunc(width) || 1);
  const h = Math.max(1, Math.trunc(height) || 1);
  const longest = Math.max(w, h);
  if (longest <= maxDim) return { width: w, height: h };

  const scale = maxDim / longest;
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
  };
}

// ---------------------------------------------------------------------------
// Capture frame validation + draw (pure, node-testable)
// ---------------------------------------------------------------------------

/** `<video>.readyState` threshold for a decodable frame (HAVE_CURRENT_DATA).
 *  Hard-coded instead of `HTMLMediaElement.HAVE_CURRENT_DATA` so this module
 *  stays importable and testable in Node where the DOM constant does not
 *  exist. Value is stable across Chrome/Edge/Firefox. */
export const CAMERA_HAVE_CURRENT_DATA = 2;

/**
 * The `<video>` fields the capture path is allowed to depend on. Distilled via
 * `videoWidth` / `videoHeight` (intrinsic media dimensions) only —
 * `clientWidth` / `clientHeight` are layout dimensions and are deliberately
 * excluded so a CSS-sized preview can never feed a stretched/black canvas.
 */
export interface CaptureVideoSource {
  readyState: number;
  videoWidth: number;
  videoHeight: number;
}

export type CaptureFrameResolution =
  | { status: "ready"; videoWidth: number; videoHeight: number }
  | { status: "no-video" }
  | { status: "no-frame" };

/**
 * Gate that must pass BEFORE any canvas work. A capture is only "ready" when
 * the bound element exists, has actually decoded a frame (HAVE_CURRENT_DATA),
 * and exposes valid intrinsic dimensions. Anything else resolves to a
 * controlled reason so the caller can surface an error instead of silently
 * encoding a blank/black canvas.
 */
export function resolveCaptureFrame(
  video: CaptureVideoSource | null
): CaptureFrameResolution {
  if (!video) return { status: "no-video" };
  if (video.readyState < CAMERA_HAVE_CURRENT_DATA) return { status: "no-frame" };
  if (!(video.videoWidth > 0) || !(video.videoHeight > 0)) return { status: "no-frame" };
  return {
    status: "ready",
    videoWidth: video.videoWidth,
    videoHeight: video.videoHeight,
  };
}

/**
 * Draws the currently displayed video frame onto a canvas at the intrinsic
 * source dimensions. CSS transforms on the <video> are visual only and would
 * never affect `drawImage` anyway; the pipeline never mirrors the bitmap (the
 * preview isn't mirrored in the UI), so orientation is preserved as-is.
 * Returns false only when no source element is bound — the caller already
 * gated on a ready frame, so false here means the element disappeared mid-
 * capture and must be surfaced as a capture error, never a black frame.
 */
export function drawVideoFrameIntoCanvas(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement | null,
  width: number,
  height: number
): boolean {
  if (!video) return false;
  ctx.drawImage(video, 0, 0, width, height);
  return true;
}

/**
 * Small orchestration seam used by the hook (and by the tests) to make the
 * "only draw when a real decoded frame exists" rule explicit and testable: the
 * draw callback is invoked with the intrinsic dimensions ONLY when the source
 * passed the frame-validity gate. Invalid sources never reach the draw/encode
 * stage, so a black canvas can never be produced from a missing/undecoded
 * source.
 */
export function beginPhotoCapture(
  video: CaptureVideoSource | null,
  draw: (video: CaptureVideoSource, width: number, height: number) => void
): CaptureFrameResolution {
  const resolution = resolveCaptureFrame(video);
  if (resolution.status === "ready") {
    draw(video as CaptureVideoSource, resolution.videoWidth, resolution.videoHeight);
  }
  return resolution;
}

/**
 * Validity gate for the data URL produced by capture encoding. A capture must
 * yield a real `data:image/*;base64,...` payload — anything degenerate (empty,
 * non-data, unsupported image MIME) is rejected so a broken/black URL can
 * never be presented as a captured photo. Never logs the URL itself.
 */
export function isValidCapturedDataUrl(dataUrl: string): boolean {
  if (typeof dataUrl !== "string") return false;
  if (!dataUrl.startsWith("data:")) return false;
  return /^data:image\/(?:jpeg|png|webp);base64,.+/.test(dataUrl);
}

// ---------------------------------------------------------------------------
// Stream + object-URL cleanup (pure, testable with mocks)
// ---------------------------------------------------------------------------

/** Minimal track shape so tests can pass plain stubs. */
export interface CameraTrackHandle {
  stop(): void;
  readyState?: string;
}

/**
 * Stops every track in a list exactly once. Idempotent — trivially safe when
 * called with an empty list or after the stream has already stopped.
 */
export function stopAllTracks(tracks: CameraTrackHandle[] | null | undefined): void {
  if (!tracks) return;
  for (const track of tracks) {
    if (track && typeof track.stop === "function") {
      track.stop();
    }
  }
}

/** Revokes a single object URL (no-op for null/undefined). */
export function revokeObjectUrl(url: string | null | undefined): void {
  if (!url) return;
  if (typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
    URL.revokeObjectURL(url);
  }
}

// ---------------------------------------------------------------------------
// Camera UI state machine (pure reducer — drives the hook + dialog)
// ---------------------------------------------------------------------------

export type CameraUiState =
  | "idle"      // closed, nothing captured
  | "requesting" // permission prompt / stream startup in progress
  | "active"    // live preview showing
  | "captured"  // still image preview showing (stream stopped)
  | "error";    // camera unavailable — message in `error`

export type CameraEvent =
  | { type: "open_request" }
  | { type: "open_success" }
  | { type: "capture_success" }
  | { type: "retake" }
  | { type: "use_photo" }
  | { type: "close" }
  | { type: "error"; message: string };

export interface CameraUiStateResult {
  state: CameraUiState;
  /** Friendly error copy present only in the "error" state. */
  error: string | null;
}

export const CAMERA_INITIAL_UI: CameraUiStateResult = {
  state: "idle",
  error: null,
};

export function cameraReducer(
  current: CameraUiStateResult,
  event: CameraEvent
): CameraUiStateResult {
  switch (event.type) {
    case "open_request":
      return { state: "requesting", error: null };
    case "open_success":
      return { state: "active", error: null };
    case "capture_success":
      return { state: "captured", error: null };
    case "retake":
      return { state: "requesting", error: null };
    case "use_photo":
    case "close":
      return { state: "idle", error: null };
    case "error":
      return { state: "error", error: event.message ?? null };
    default:
      return current;
  }
}

// ---------------------------------------------------------------------------
// Captured image payload
// ---------------------------------------------------------------------------

/** A normalized camera capture ready for the chat pipeline. */
export interface CameraCapturedImage {
  /** JPEG/PNG/WebP data URL (normalized, bounded). */
  dataUrl: string;
  mimeType: string;
  name: string;
  width: number;
  height: number;
  /** Byte size of the payload. */
  sizeBytes: number;
}

/**
 * Builds the attachment object sent to the chat pipeline. Pure +
 * side-effect-free: construction never logs or persists image bytes.
 */
export function buildCameraAttachment(input: {
  dataUrl: string;
  mimeType: string;
  name?: string;
  width: number;
  height: number;
  sizeBytes: number;
}): CameraCapturedImage {
  return {
    dataUrl: input.dataUrl,
    mimeType: input.mimeType,
    name: input.name?.trim() || "Camera photo",
    width: input.width,
    height: input.height,
    sizeBytes: input.sizeBytes,
  };
}

/**
 * Effective prompt for a send action. When the user attaches a photo but
 * typed nothing, the composer falls back to a single default describe-this
 * request (the user still controls text whenever they choose to type).
 */
export function resolveSendPrompt(rawText: string, hasImage: boolean): string {
  const trimmed = rawText.trim();
  if (trimmed) return trimmed;
  return hasImage ? DEFAULT_CAMERA_PROMPT : "";
}

// ---------------------------------------------------------------------------
// Phase 7E.1 — Clipboard image paste (pure client helpers)
// ---------------------------------------------------------------------------
//
// Clipboard input is normalized into the SAME attachment model as the camera:
// a camera/pasted photo ultimately becomes a `CameraCapturedImage`, then a
// `ChatUserImageAttachment`, then the existing `uploadedImage` field. There is
// intentionally no second paste image pipeline. All decision logic below is
// pure and Node-testable; only the final Blob→dataURL decode (FileReader) and
// the ≤1600px canvas re-draw run in the browser.

export type PasteImageErrorCode =
  | "unsupported-mime"
  | "too-large"
  | "no-image"
  | "processing-failed";

const PASTE_IMAGE_ERROR_MESSAGES: Record<PasteImageErrorCode, string> = {
  "unsupported-mime":
    "This image format isn't supported. Please use JPEG, PNG, or WebP.",
  "too-large": "This image is too large. Please use an image under 5 MB.",
  "no-image": "No usable image was found in the clipboard.",
  "processing-failed": "Unable to process this image. Please try another image.",
};

export function pasteImageErrorMessage(code: PasteImageErrorCode): string {
  return PASTE_IMAGE_ERROR_MESSAGES[code] ?? PASTE_IMAGE_ERROR_MESSAGES["no-image"];
}

/**
 * Minimal clipboard-source shape (a `DataTransferItem` or a `File` both
 * satisfy it structurally), so paste inspection stays testable in Node.
 */
export interface PasteSourceDescriptor {
  /** DataTransferItem.kind ("file" | "string"); FileList entries have none. */
  kind?: string;
  /** MIME type (item.type or File.type). */
  type?: string;
  /** File.name — present on FileList entries. */
  name?: string;
  /** File.size — present on FileList entries. */
  size?: number;
}

export type ClipboardPick =
  | { found: false }
  | {
      found: true;
      supported: boolean;
      mimeType: string;
      name: string | null;
      sizeBytes: number | null;
    };

/**
 * Decides whether a paste should be intercepted as an image. Scans the paste
 * event's items then files and returns the FIRST `image/*` entry. Ordinary
 * text pastes find nothing, so the caller lets the browser's default paste
 * proceed untouched. An image is reported even when unsupported so the caller
 * can reject it with a friendly message instead of silently pasting garbage.
 */
export function pickClipboardImage(
  items: Iterable<PasteSourceDescriptor>,
  files: Iterable<PasteSourceDescriptor>
): ClipboardPick {
  for (const source of [...items, ...files]) {
    const type = typeof source.type === "string" ? source.type.trim().toLowerCase() : "";
    if (!type.startsWith("image/")) continue;
    const kind = typeof source.kind === "string" ? source.kind.toLowerCase() : "";
    // A "string" kind item is e.g. copied HTML — never an image source. Item
    // entries of kind "file" (and FileList entries, which carry no kind) are.
    if (kind !== "string") {
      return {
        found: true,
        supported: isCameraMimeSupported(type),
        mimeType: type,
        name: typeof source.name === "string" && source.name.trim() ? source.name.trim() : null,
        sizeBytes:
          typeof source.size === "number" && Number.isFinite(source.size) ? source.size : null,
      };
    }
  }
  return { found: false };
}

/** True when the paste handler must `preventDefault()` (an image is present). */
export function shouldInterceptImagePaste(
  items: Iterable<PasteSourceDescriptor>,
  files: Iterable<PasteSourceDescriptor>
): boolean {
  return pickClipboardImage(items, files).found;
}

/**
 * Client-side gate for a pasted image. Reuses the exact camera MIME + byte
 * policy (JPEG/PNG/WebP, ≤ 5 MB) so clipboard can never smuggle a format the
 * server would reject later. The server's `validateSourceImage` remains the
 * authoritative magic-byte boundary.
 */
export function validatePastedImage(input: {
  mimeType: string;
  sizeBytes: number | null;
}): { ok: true } | { ok: false; code: PasteImageErrorCode } {
  if (!isCameraMimeSupported(input.mimeType)) {
    return { ok: false, code: "unsupported-mime" };
  }
  if (input.sizeBytes != null && !isCameraImageWithinSize(input.sizeBytes)) {
    return { ok: false, code: "too-large" };
  }
  return { ok: true };
}

/** Display name for a pasted image: the file name when present, else a generic. */
export function pastedImageName(fileName: string | null | undefined): string {
  const trimmed = typeof fileName === "string" ? fileName.trim() : "";
  return trimmed || "Pasted image";
}