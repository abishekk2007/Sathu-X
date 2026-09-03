"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import {
  CheckIcon,
  CopyIcon,
  ExternalLinkIcon,
  FileIcon,
  GlobeIcon,
  ImageIcon,
  MapPinIcon,
  RefreshCwIcon,
  SquareIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
  Volume2Icon,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { MarkdownContent } from "@/components/chat/markdown-content";
import { markdownToSpeechText, hasSpeakableText } from "@/lib/speech-output";
import type { SpeechController } from "@/hooks/use-speech-synthesis";
import type { ChatMessage } from "@/types";

// Phase 8 — Load the Leaflet map only in the browser (Leaflet touches `window`
// at module scope, so `ssr: false` prevents any server-side import/crash).
const LeafletMap = dynamic(
  () => import("@/components/map/leaflet-map").then((m) => m.default),
  { ssr: false }
);

interface AssistantMessageProps {
  message: ChatMessage;
  feedback?: "up" | "down";
  onFeedback: (value: "up" | "down") => void;
  onRegenerate?: () => void;
  /** Shared voice-output controller from the chat workspace. */
  speech?: SpeechController;
}

function ActionButton({
  label,
  active,
  ...props
}: React.ComponentProps<typeof Button> & { label: string; active?: boolean }) {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      title={label}
      className={active ? "text-primary" : "text-muted-foreground"}
      {...props}
    />
  );
}

export function AssistantMessage({
  message,
  feedback,
  onFeedback,
  onRegenerate,
  speech,
}: AssistantMessageProps) {
  const [copied, setCopied] = React.useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      toast.success("Response copied");
      setTimeout(() => setCopied(false), 1600);
    } catch {
      toast.error("Could not copy to clipboard");
    }
  };

  const isThisSpeaking =
    speech?.isSpeaking && speech.speakingMessageId === message.id;

  const toggleSpeak = () => {
    if (!speech || !speech.isSupported) return;
    if (isThisSpeaking) {
      speech.stop();
    } else {
      const text = markdownToSpeechText(message.content);
      if (!hasSpeakableText(text)) {
        toast.error("There is no text to read aloud.");
        return;
      }
      speech.speak(text, message.id);
    }
  };

  return (
    <article
      aria-label="SathuX response"
      className="group/msg flex gap-3"
    >
      <div className="min-w-0 flex-1 space-y-1">
        {message.image ? (
          // Phase 6C: the image arrived as a server-validated data URL inside
          // the JSON image_message — render it directly from that payload.
          <figure className="space-y-1.5">
            {/* next/image can't ingest an inline validated data URL without a
                loader; the ephemeral, user-generated image renders best as an
                unoptimized <img> straight from the server payload. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={message.image.dataUrl}
              alt={message.content || "Generated image"}
              className="max-h-[480px] w-full max-w-2xl rounded-xl border bg-muted object-contain"
            />
            {message.image.prompt ? (
              <figcaption className="text-xs text-muted-foreground">
                {message.image.provider === "gemini" ? "Gemini" : "Hugging Face"} · {message.image.prompt}
              </figcaption>
            ) : null}
            {message.image.sourceGrounded ? (
              <figcaption className="text-xs text-muted-foreground">
                Based on your document · {message.image.visualType ?? "visual"}
              </figcaption>
            ) : null}
          </figure>
        ) : null}
        <MarkdownContent content={message.content} />
        {message.documentCitations && message.documentCitations.length > 0 ? (
          // Phase 7D — real document citations (from application retrieval
          // metadata, never model-invented). Kept visually distinct from web
          // sources so the user never has to guess whether a source came from
          // their own uploaded document or the internet.
          <div className="pt-1.5">
            <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <FileIcon className="size-3.5" />
              <span>
                Document sources ({message.documentCitations.length})
              </span>
            </div>
            <ol className="mt-1.5 flex flex-col gap-1">
              {message.documentCitations.map((citation, index) => (
                <li
                  key={`${citation.sourceId}-${citation.page ?? "unknown"}-${index}`}
                  className="flex items-start gap-2 rounded-lg border border-border/60 bg-muted/40 px-2.5 py-1.5 text-xs text-muted-foreground"
                >
                  <span className="mt-0.5 shrink-0 select-none font-semibold text-primary">
                    {citation.page != null ? `p.${citation.page}` : "doc"}
                  </span>
                  <span className="min-w-0 flex-1 leading-snug">
                    {citation.sourceName}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        ) : null}
        {message.sources && message.sources.length > 0 ? (
          // Phase 7C — real web-research citations. The app owns these links
          // (from the server control frame); they are never model-invented.
          <div className="pt-1.5">
            <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <GlobeIcon className="size-3.5" />
              <span>Web sources ({message.sources.length})</span>
              {message.researchDegraded ? (
                <span className="ml-auto font-normal text-[11px]">
                  Some sources were partial
                </span>
              ) : null}
            </div>
            <ol className="mt-1.5 flex flex-col gap-1">
              {message.sources.map((source) => (
                <li key={source.url}>
                  <a
                    href={source.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="group flex items-start gap-2 rounded-lg border border-border/60 bg-muted/40 px-2.5 py-1.5 text-xs transition-colors hover:border-primary/40 hover:bg-muted/70"
                  >
                    <span className="mt-0.5 shrink-0 select-none font-semibold text-primary">
                      {source.index}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium leading-snug text-foreground group-hover:underline">
                        {source.title || source.domain}
                      </span>
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {source.domain}
                        {source.publishedAt ? ` · ${source.publishedAt}` : ""}
                      </span>
                    </span>
                    <ExternalLinkIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                  </a>
                </li>
              ))}
            </ol>
          </div>
        ) : null}
        {message.webImages && message.webImages.length > 0 ? (
          // Phase 7F — real web-image results surfaced by an image search
          // ("show me images of…"). App-owned https URLs from the server
          // control frame, thumbnails only — rendered with no-referrer so the
          // remote host neither sees the session nor sets cookies back.
          <div className="pt-1.5">
            <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <ImageIcon className="size-3.5" />
              <span>Web images ({message.webImages.length})</span>
            </div>
            <div className="mt-1.5 grid grid-cols-2 gap-1.5 sm:grid-cols-3 md:grid-cols-4">
              {message.webImages.map((webImage, index) => (
                <a
                  key={webImage.url}
                  href={webImage.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={
                    webImage.title
                      ? `${webImage.title} (web image ${index + 1})`
                      : `Web image ${index + 1}, opens in a new tab`
                  }
                  className="group flex flex-col gap-1 rounded-lg border border-border/60 bg-muted/40 p-1 transition-colors hover:border-primary/40"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={webImage.url}
                    alt={webImage.description || webImage.title || "Web image"}
                    loading="lazy"
                    referrerPolicy="no-referrer"
                    className="aspect-square w-full rounded-md object-cover"
                  />
                  {webImage.title ? (
                    <span className="truncate px-0.5 pb-0.5 text-[11px] text-muted-foreground group-hover:text-foreground">
                      {webImage.title}
                    </span>
                  ) : null}
                </a>
              ))}
            </div>
          </div>
        ) : null}
        {message.places && message.places.length > 0 ? (
          // Phase 8 — real nearby places fetched from OpenStreetMap/Nominatim,
          // rendered on an interactive Leaflet map. Coordinates are validated
          // upstream; places without valid coords never reach this block.
          <div className="pt-1.5">
            <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <MapPinIcon className="size-3.5" />
              <span>
                Nearby places ({message.places.length}){" "}
                <span className="font-normal text-muted-foreground/70">
                  — OpenStreetMap
                </span>
              </span>
            </div>
            <React.Suspense
              fallback={<div className="h-40 w-full rounded-md bg-muted text-xs text-muted-foreground flex items-center justify-center">Loading map…</div>}
            >
              <LeafletMap
                userLocation={message.userLocation}
                places={message.places}
              />
            </React.Suspense>
            <ul className="mt-1.5 space-y-1">
              {message.places.map((place) => (
                <li key={place.id} className="flex items-start justify-between gap-2 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block size-2 shrink-0 rounded-full bg-red-500" />
                    {place.name}
                  </span>
                  {place.openInGoogleMaps ? (
                    <a
                      href={place.openInGoogleMaps}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="shrink-0 font-medium text-primary hover:underline"
                    >
                      Open in Google Maps
                    </a>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {message.status === "complete" ? (
          <div className="-ml-2 flex items-center gap-0.5 pt-1 opacity-60 transition-opacity group-hover/msg:opacity-100 focus-within:opacity-100 hover:opacity-100">
            {speech?.isSupported ? (
              <ActionButton
                label={isThisSpeaking ? "Stop speaking" : "Read response aloud"}
                active={isThisSpeaking}
                onClick={toggleSpeak}
              >
                {isThisSpeaking ? (
                  <SquareIcon className="size-3" fill="currentColor" />
                ) : (
                  <Volume2Icon className="size-3.5" />
                )}
              </ActionButton>
            ) : null}
            <ActionButton label="Copy response" onClick={copy}>
              {copied ? <CheckIcon /> : <CopyIcon />}
            </ActionButton>
            {onRegenerate ? (
              <ActionButton label="Regenerate response" onClick={onRegenerate}>
                <RefreshCwIcon />
              </ActionButton>
            ) : null}
            <ActionButton
              label="Good response"
              active={feedback === "up"}
              onClick={() => onFeedback("up")}
            >
              <ThumbsUpIcon />
            </ActionButton>
            <ActionButton
              label="Bad response"
              active={feedback === "down"}
              onClick={() => onFeedback("down")}
            >
              <ThumbsDownIcon />
            </ActionButton>
          </div>
        ) : null}
      </div>
    </article>
  );
}
