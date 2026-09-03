"use client";

import * as React from "react";
import { CameraIcon, RefreshCcwIcon, XIcon, ImageIcon } from "lucide-react";

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { UseCameraReturn } from "@/hooks/use-camera";
import type { CameraCapturedImage } from "@/lib/camera";

interface CameraDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The shared camera controller (owned by the composer so permission is
   *  requested synchronously in the user's click handler). */
  camera: UseCameraReturn;
  /** The <video> element ref — owned by the composer (element owner) and
   *  passed down so no ref ever flows through a hook's render surface. */
  videoRef: React.RefObject<HTMLVideoElement | null>;
  onPhoto: (photo: CameraCapturedImage) => void;
}

/**
 * Phase 7E — focused camera panel. Renders the camera lifecycle states from a
 * shared controller: permission request → live preview → capture → preview →
 * retake / use photo. Uses the top-level Dialog so it is keyboard-accessible
 * and appears in a portal consistent with the rest of SathuX.
 */
export function CameraDialog({
  open,
  onOpenChange,
  camera,
  videoRef,
  onPhoto,
}: CameraDialogProps) {
  // Attach / detach the live preview. Refs are only read inside this effect
  // (never during render), and the stream is only wired once it is "active".
  React.useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (camera.state === "active" && camera.previewStream) {
      if (video.srcObject !== camera.previewStream) {
        video.srcObject = camera.previewStream;
      }
    } else if (video.srcObject) {
      video.srcObject = null;
      video.pause?.();
    }
  }, [camera.state, camera.previewStream, videoRef]);

  // Closing the dialog (X, Escape, overlay, or parent unmount) fully stops the
  // camera + resets state. Opening is initiated by the composer's click
  // handler (`camera.open()` runs synchronously within that gesture).
  React.useEffect(() => {
    if (!open) camera.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const handleUsePhoto = () => {
    if (!camera.capturedImage) return;
    onPhoto(camera.capturedImage);
    camera.usePhoto();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-md"
        aria-description="Capture a photo to attach to your message"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CameraIcon className="size-4" />
            Camera
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {camera.state === "active" || camera.state === "requesting" ? (
            <div className="relative aspect-[4/3] overflow-hidden rounded-lg bg-black">
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                className="size-full object-cover"
                aria-label="Camera preview"
              />
              {camera.state === "requesting" && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/30">
                  <p className="text-xs font-medium text-white/90">
                    Requesting camera…
                  </p>
                </div>
              )}
            </div>
          ) : camera.state === "captured" && camera.capturedImage ? (
            <div className="relative aspect-[4/3] overflow-hidden rounded-lg bg-black">
              {/* An application-owned still: the user explicitly froze this
                  frame, so rendering it is safe. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={camera.capturedImage.dataUrl}
                alt="Captured photo preview"
                className="size-full object-cover"
              />
            </div>
          ) : camera.state === "error" ? (
            <div
              role="alert"
              className="flex flex-col items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-6 text-center"
            >
              <ImageIcon className="size-5 text-destructive" />
              <p className="text-sm font-medium text-destructive">{camera.error}</p>
              {camera.error?.includes("denied") ? (
                <p className="text-xs text-muted-foreground">
                  You can change this in your browser&apos;s site permissions and try
                  again.
                </p>
              ) : null}
            </div>
          ) : null}

          {/* Controls */}
          <div className="flex items-center justify-center gap-2">
            {camera.state === "requesting" ? (
              <Button variant="ghost" size="sm" disabled>
                Starting…
              </Button>
            ) : camera.state === "active" ? (
              <>
                <Button
                  variant="secondary"
                  size="icon"
                  aria-label="Close camera"
                  onClick={() => {
                    camera.close();
                    onOpenChange(false);
                  }}
                >
                  <XIcon className="size-4" />
                </Button>
                <Button
                  aria-label="Capture photo"
                  onClick={() => void camera.capture()}
                  className="size-14 rounded-full"
                >
                  <span className="size-10 rounded-full border-2 border-background" />
                </Button>
                <span className="w-8" />
              </>
            ) : camera.state === "captured" ? (
              <>
                <Button
                  variant="outline"
                  aria-label="Retake photo"
                  onClick={() => camera.retake()}
                >
                  <RefreshCcwIcon className="size-4" />
                  Retake
                </Button>
                <Button
                  aria-label="Use photo"
                  onClick={handleUsePhoto}
                >
                  Use Photo
                </Button>
              </>
            ) : camera.state === "error" ? (
              <Button
                variant="outline"
                aria-label="Close camera"
                onClick={() => {
                  camera.close();
                  onOpenChange(false);
                }}
              >
                Close
              </Button>
            ) : null}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}