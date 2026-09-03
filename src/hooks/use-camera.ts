"use client";

import * as React from "react";

import {
  CAMERA_IMAGE_QUALITY,
  cameraErrorMessage,
  cameraReducer,
  CAMERA_INITIAL_UI,
  cameraSupported,
  drawVideoFrameIntoCanvas,
  isValidCapturedDataUrl,
  mapCameraError,
  resolveCaptureFrame,
  stopAllTracks,
  type CameraCapturedImage,
  type CameraUiState,
} from "@/lib/camera";

export interface UseCameraOptions {
  /**
   * The `<video>` element the live preview renders into. Optional — capture
   * falls back to the normalized default dimensions if no element is bound.
   * Kept OUT of the hook's return value so refs never flow through the render
   * surface (compatible with this repo's `react-hooks/refs` rule).
   */
  videoRef?: React.RefObject<HTMLVideoElement | null>;
  /** Override for the getUserMedia provider (tests / stubs). */
  getUserMediaProvider?: () => Promise<MediaStream>;
}

export interface UseCameraReturn {
  /** Hydration-safe camera support flag (false on SSR + first client render). */
  isSupported: boolean;
  /** Current camera UI state: idle → requesting → active → captured. */
  state: CameraUiState;
  /** Friendly, human-readable error message (null when not in an error state). */
  error: string | null;
  /** The frozen still prepared for attaching to the pending message. */
  capturedImage: CameraCapturedImage | null;
  /** The live MediaStream while active. Consumers attach it to their bound
   *  <video> inside an effect — refs are only ever read post-mount. */
  previewStream: MediaStream | null;
  open: () => void;
  close: () => void;
  capture: () => void;
  retake: () => void;
  usePhoto: () => void;
}

const DEFAULT_MEDIA_CONSTRAINTS: MediaStreamConstraints = {
  video: {
    facingMode: "environment",
    width: { ideal: 1920 },
    height: { ideal: 1080 },
  },
  audio: false,
};

/**
 * Phase 7E — camera lifecycle controller.
 *
 * - The permission prompt is ONLY ever triggered from a user interaction
 *   (the composer calls `open()` inside its click handler), never from a
 *   timer/effect — the caller is responsible for that sequencing.
 * - Support detection is deferred into a post-mount `setTimeout`, so SSR and
 *   the first client render deterministically report `false`, matching the
 *   7A hydration-safety lesson.
 * - No browser global is read at module scope; `navigator`, `document`,
 *   `canvas`, and `FileReader` are only touched inside the handlers that run
 *   after a user gesture.
 */
export function useCamera(options: UseCameraOptions = {}): UseCameraReturn {
  const { videoRef } = options;

  const [ui, dispatch] = React.useReducer(cameraReducer, CAMERA_INITIAL_UI);
  const [isSupported, setIsSupported] = React.useState(false);
  const [capturedImage, setCapturedImage] =
    React.useState<CameraCapturedImage | null>(null);
  const [previewStream, setPreviewStream] = React.useState<MediaStream | null>(
    null
  );

  const streamRef = React.useRef<MediaStream | null>(null);
  const mountedRef = React.useRef(true);
  const captureInFlightRef = React.useRef(false);

  // Detect camera support after hydration; deferred with a timer so the
  // initial client render produces markup identical to the server shell.
  React.useEffect(() => {
    const id = window.setTimeout(() => {
      setIsSupported(cameraSupported());
    }, 0);
    return () => window.clearTimeout(id);
  }, []);

  const stopStream = React.useCallback(() => {
    const stream = streamRef.current;
    if (stream) stopAllTracks(stream.getTracks());
    streamRef.current = null;
    setPreviewStream(null);
  }, []);

  // Unmount teardown — stop the stream and tracks, discard anything captured.
  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const stream = streamRef.current;
      if (stream) stopAllTracks(stream.getTracks());
      streamRef.current = null;
    };
  }, []);

  // Classify + surface a getUserMedia failure. Logs ONLY safe diagnostic
  // classification (error code, error name, short reason) — never image bytes,
  // base64, data URLs, keys, or environment values.
  const reportCameraError = React.useCallback((err: unknown) => {
    const code = mapCameraError(err);
    if (code === "unknown") {
      const name =
        err && typeof err === "object" ? String((err as { name?: unknown }).name ?? "") : "";
      const message =
        err instanceof Error && err.message ? String(err.message) : "";
      console.warn(`[camera] getUserMedia failed code=${code} name=${name} msg=${message}`);
    }
    if (mountedRef.current) {
      dispatch({ type: "error", message: cameraErrorMessage(code) });
    }
  }, []);

  const open = React.useCallback(() => {
    // Called synchronously from the composer's click handler — the only
    // entry point. Never called from an effect or timer by the UI.
    if (!cameraSupported()) {
      if (mountedRef.current) {
        dispatch({
          type: "error",
          message: cameraErrorMessage("not-supported"),
        });
      }
      return;
    }

    if (streamRef.current) stopStream();
    dispatch({ type: "open_request" });

    // Robust, browser-compatible constraint strategy. The preferred attempt
    // still prefers the rear/environment camera; a minimalist `{ video: true }`
    // fallback covers devices/drivers that reject ideal-width hints. Always
    // invoked with `this` bound to the real MediaDevices object — extracting
    // getUserMedia and calling it with `null` can reject as an unclassified
    // "Illegal invocation" TypeError on some engines.
    const getUserMedia = navigator.mediaDevices?.getUserMedia;

    const attempts: Array<() => Promise<MediaStream>> = options.getUserMediaProvider
      ? [() => options.getUserMediaProvider!()]
      : typeof getUserMedia === "function"
        ? [
            () => getUserMedia.call(navigator.mediaDevices, DEFAULT_MEDIA_CONSTRAINTS),
            () => getUserMedia.call(navigator.mediaDevices, { video: true, audio: false }),
          ]
        : [];

    if (attempts.length === 0) {
      if (mountedRef.current) {
        dispatch({
          type: "error",
          message: cameraErrorMessage("not-supported"),
        });
      }
      return;
    }

    let streamPromise: Promise<MediaStream>;
    try {
      streamPromise = attempts[0]();
    } catch (err) {
      // Some engines throw synchronously for runtime-start failures instead of
      // rejecting the promise. Surface it through the same friendly path so the
      // dialog never gets stuck on "Requesting camera…".
      reportCameraError(err);
      return;
    }

    streamPromise
      .then((stream: MediaStream) => {
        if (!mountedRef.current) {
          stopAllTracks(stream.getTracks());
          return;
        }
        streamRef.current = stream;
        setPreviewStream(stream);
        dispatch({ type: "open_success" });
      })
      .catch((err: unknown) => {
        const code = mapCameraError(err);
        // Errors that relaxed constraints cannot fix fail fast; start-class
        // failures (Overconstrained / TypeError / NotReadable) retry once with
        // minimal constraints in the same open() call.
        if (code === "permission-denied" || code === "no-camera" || code === "insecure-context") {
          reportCameraError(err);
          return;
        }
        const fallback = attempts[1];
        if (fallback) {
          let fallbackPromise: Promise<MediaStream>;
          try {
            fallbackPromise = fallback();
          } catch (fallbackErr) {
            reportCameraError(fallbackErr);
            return;
          }
          fallbackPromise
            .then((stream: MediaStream) => {
              if (!mountedRef.current) {
                stopAllTracks(stream.getTracks());
                return;
              }
              streamRef.current = stream;
              setPreviewStream(stream);
              dispatch({ type: "open_success" });
            })
            .catch((fallbackErr: unknown) => reportCameraError(fallbackErr));
          return;
        }
        reportCameraError(err);
      });
  }, [options.getUserMediaProvider, stopStream, reportCameraError]);

  const close = React.useCallback(() => {
    stopStream();
    if (mountedRef.current) {
      setCapturedImage(null);
      dispatch({ type: "close" });
    }
  }, [stopStream]);

  // Bounded readiness wait for a decoded video frame. Uses the media events a
  // frame-producing element actually fires (`loadeddata`, `canplay`) plus a
  // requestAnimationFrame check against the pure gate; the timer is only a hard
  // cap so a camera that never produces a frame degrades to a controlled error
  // instead of hanging. No arbitrary fixed delay is used as the wait mechanism.
  const waitForDecodedFrame = React.useCallback(
    (video: HTMLVideoElement | null, onReady: () => void, onFail: () => void) => {
      if (!video) {
        onFail();
        return;
      }
      let done = false;
      let rafId = 0;
      let capTimer = 0;
      const finish = () => {
        if (done) return;
        done = true;
        video.removeEventListener("loadeddata", onFrame);
        video.removeEventListener("canplay", onFrame);
        video.removeEventListener("error", onMediaError);
        if (rafId) cancelAnimationFrame(rafId);
        window.clearTimeout(capTimer);
      };
      const onFrame = () => {
        finish();
        onReady();
      };
      const onMediaError = () => {
        finish();
        onFail();
      };
      const poll = () => {
        if (done) return;
        if (resolveCaptureFrame(video).status === "ready") {
          finish();
          onReady();
          return;
        }
        rafId = requestAnimationFrame(poll);
      };
      video.addEventListener("loadeddata", onFrame);
      video.addEventListener("canplay", onFrame);
      video.addEventListener("error", onMediaError);
      rafId = requestAnimationFrame(poll);
      capTimer = window.setTimeout(() => {
        finish();
        onFail();
      }, 2000);
    },
    []
  );

  const capture = React.useCallback(() => {
    // Capture is only meaningful while a stream is actually live.
    if (!streamRef.current) return;
    if (captureInFlightRef.current) return;
    captureInFlightRef.current = true;

    const failCapture = (message: string) => {
      captureInFlightRef.current = false;
      if (mountedRef.current) {
        dispatch({ type: "error", message });
      }
    };

    // Freeze AFTER the frame is drawn + encoded: the canvas draw happens
    // synchronously above, the stream is only stopped once the still data URL
    // exists. Stopping tracks before drawing produced the black frames.
    const encodeFrame = (
      video: HTMLVideoElement | null,
      width: number,
      height: number
    ) => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        failCapture("Unable to capture this frame.");
        return;
      }
      // Draw at intrinsic media dimensions (videoWidth/videoHeight), never CSS
      // layout dimensions, and never a placeholder element.
      const drew = drawVideoFrameIntoCanvas(ctx, video, width, height);
      if (!drew) {
        failCapture("Unable to capture this frame.");
        return;
      }
      canvas.toBlob(
        (blob) => {
          if (!mountedRef.current || !streamRef.current) {
            captureInFlightRef.current = false;
            return;
          }
          if (!blob) {
            failCapture("Unable to capture this frame.");
            return;
          }
          const reader = new FileReader();
          reader.onloadend = () => {
            if (!mountedRef.current || !streamRef.current) {
              captureInFlightRef.current = false;
              return;
            }
            const dataUrl = String(reader.result ?? "");
            // Validate the encoded result is a real image payload, never a
            // degenerate/blank URL. (Diagnostics never log image bytes.)
            if (!isValidCapturedDataUrl(dataUrl)) {
              failCapture("Unable to capture this frame.");
              return;
            }
            setCapturedImage({
              dataUrl,
              mimeType: blob.type || "image/jpeg",
              name: "Camera photo",
              width,
              height,
              sizeBytes: blob.size,
            });
            if (streamRef.current) stopAllTracks(streamRef.current.getTracks());
            streamRef.current = null;
            setPreviewStream(null);
            captureInFlightRef.current = false;
            dispatch({ type: "capture_success" });
          };
          reader.readAsDataURL(blob);
        },
        "image/jpeg",
        CAMERA_IMAGE_QUALITY
      );
    };

    // The live bound element is read directly inside this event handler (never
    // during render) — a cached/watered-down mirror of the element could be
    // stale (null while the dialog is closed) and silently produce black.
    const theVideo = videoRef?.current ?? null;
    const resolution = resolveCaptureFrame(theVideo);
    if (resolution.status !== "ready") {
      // Frame not decoded yet: wait for a real frame (media events + rAF),
      // then attempt. A controlled error is never a silent black capture.
      waitForDecodedFrame(
        theVideo,
        () => {
          const v = videoRef?.current ?? null;
          const next = resolveCaptureFrame(v);
          if (next.status === "ready") {
            encodeFrame(v, next.videoWidth, next.videoHeight);
          } else {
            failCapture("Unable to capture this frame.");
          }
        },
        () => failCapture("Unable to capture this frame.")
      );
      return;
    }
    encodeFrame(theVideo, resolution.videoWidth, resolution.videoHeight);
  }, [videoRef, waitForDecodedFrame]);

  const retake = React.useCallback(() => {
    dispatch({ type: "retake" });
    open();
  }, [open]);

  const usePhoto = React.useCallback(() => {
    stopStream();
    if (mountedRef.current) {
      setCapturedImage(null);
      dispatch({ type: "use_photo" });
    }
  }, [stopStream]);

  return {
    isSupported,
    state: ui.state,
    error: ui.error,
    capturedImage,
    previewStream,
    open,
    close,
    capture,
    retake,
    usePhoto,
  };
}