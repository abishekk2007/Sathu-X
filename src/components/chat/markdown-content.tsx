import * as React from "react";

import { CodeBlock } from "@/components/chat/code-block";
import { cn } from "@/lib/utils";

/**
 * Lightweight markdown renderer for demo AI responses.
 * Supports headings, bold, inline code, lists, blockquotes and fenced code.
 * When the real backend lands this can be swapped for a full renderer
 * without touching message components.
 */

function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  // Match: bold, italic, inline code, links, strikethrough — in one pass.
  const pattern =
    /(\*\*[^*]+\*\*|\*[^*]+\*|_[^_]+_|`[^`]+`|\[[^\]]+\]\([^)]+\)|~[^~]+~)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let index = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }
    const token = match[0];
    if (token.startsWith("**")) {
      nodes.push(
        <strong key={`${keyPrefix}-b${index}`} className="font-semibold">
          {token.slice(2, -2)}
        </strong>
      );
    } else if (token.startsWith("*") || token.startsWith("_")) {
      nodes.push(
        <em key={`${keyPrefix}-i${index}`} className="italic">
          {token.slice(1, -1)}
        </em>
      );
    } else if (token.startsWith("`")) {
      nodes.push(
        <code
          key={`${keyPrefix}-c${index}`}
          className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]"
        >
          {token.slice(1, -1)}
        </code>
      );
    } else if (token.startsWith("[")) {
      const linkMatch = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      if (linkMatch) {
        nodes.push(
          <a
            key={`${keyPrefix}-a${index}`}
            href={linkMatch[2]}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary underline underline-offset-2 hover:text-primary/80"
          >
            {linkMatch[1]}
          </a>
        );
      } else {
        nodes.push(token);
      }
    } else if (token.startsWith("~")) {
      nodes.push(
        <del key={`${keyPrefix}-s${index}`} className="text-muted-foreground line-through">
          {token.slice(1, -1)}
        </del>
      );
    } else {
      nodes.push(token);
    }
    lastIndex = pattern.lastIndex;
    index++;
  }
  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }
  return nodes;
}

function renderBlock(block: string, blockIndex: number): React.ReactNode {
  const lines = block.split("\n");
  const output: React.ReactNode[] = [];
  let listItems: string[] = [];
  let listType: "ul" | "ol" | null = null;

  const flushList = (key: string) => {
    if (!listType || listItems.length === 0) return;
    const items = listItems;
    output.push(
      listType === "ul" ? (
        <ul key={key} className="my-2 list-disc space-y-1 pl-5 marker:text-muted-foreground">
          {items.map((item, i) => (
            <li key={i}>{renderInline(item, `${key}-${i}`)}</li>
          ))}
        </ul>
      ) : (
        <ol key={key} className="my-2 list-decimal space-y-1 pl-5 marker:text-muted-foreground">
          {items.map((item, i) => (
            <li key={i}>{renderInline(item, `${key}-${i}`)}</li>
          ))}
        </ol>
      )
    );
    listItems = [];
    listType = null;
  };

  lines.forEach((line, lineIndex) => {
    const key = `b${blockIndex}-l${lineIndex}`;
    const trimmed = line.trim();

    if (trimmed === "") {
      flushList(`${key}-flush`);
      return;
    }

    const headingMatch = /^(#{1,4})\s+(.*)$/.exec(trimmed);
    if (headingMatch) {
      flushList(`${key}-flush`);
      const level = headingMatch[1].length;
      if (level <= 2) {
        output.push(
          <h3 key={key} className="mt-4 mb-1.5 text-[15px] font-semibold first:mt-0">
            {renderInline(headingMatch[2], key)}
          </h3>
        );
      } else {
        output.push(
          <h4 key={key} className="mt-3 mb-1 text-sm font-semibold">
            {renderInline(headingMatch[2], key)}
          </h4>
        );
      }
      return;
    }

    if (trimmed.startsWith("> ")) {
      flushList(`${key}-flush`);
      output.push(
        <blockquote
          key={key}
          className="my-2 rounded-r-md border-l-2 border-primary/50 bg-muted/50 px-3 py-1.5 text-sm text-muted-foreground"
        >
          {renderInline(trimmed.slice(2), key)}
        </blockquote>
      );
      return;
    }

    const ulMatch = /^[-•]\s+(.*)$/.exec(trimmed);
    const olMatch = /^\d+[.)]\s+(.*)$/.exec(trimmed);
    if (ulMatch) {
      if (listType === "ol") flushList(`${key}-flush`);
      listType = "ul";
      listItems.push(ulMatch[1]);
      return;
    }
    if (olMatch) {
      if (listType === "ul") flushList(`${key}-flush`);
      listType = "ol";
      listItems.push(olMatch[1]);
      return;
    }

    flushList(`${key}-flush`);
    output.push(<p key={key}>{renderInline(line, key)}</p>);
  });

  flushList(`b${blockIndex}-flush-end`);
  return <React.Fragment key={`b${blockIndex}`}>{output}</React.Fragment>;
}

export function MarkdownContent({ content }: { content: string }) {
  const segments = content.split(/```/);

  return (
    <div className="text-sm leading-relaxed [&>*:first-child]:mt-0">
      {segments.map((segment, i) => {
        if (i % 2 === 1) {
          // Fenced code segment — first line may hold the language.
          const newlineIndex = segment.indexOf("\n");
          const language =
            newlineIndex > -1 ? segment.slice(0, newlineIndex).trim() : "";
          const code = newlineIndex > -1 ? segment.slice(newlineIndex + 1) : segment;
          return (
            <CodeBlock key={`code-${i}`} code={code.replace(/\n$/, "")} language={language || undefined} />
          );
        }
        if (!segment.trim()) return null;
        return (
          <div key={`text-${i}`} className={cn("space-y-2")}>
            {segment.split(/\n{2,}/).map((block, j) => renderBlock(block, i * 100 + j))}
          </div>
        );
      })}
    </div>
  );
}
