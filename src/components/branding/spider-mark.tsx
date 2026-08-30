import { cn } from "@/lib/utils";

/**
 * Original geometric "web node" mark — eight spokes, two web rings and a
 * center node. Abstract AI-network inspired; not derived from any
 * copyrighted character or logo.
 */
export function SpiderMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
      className={cn("size-6", className)}
    >
      <g
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M16 16 L26.5 16 M16 16 L23.43 8.57 M16 16 L16 5.5 M16 16 L8.57 8.57 M16 16 L5.5 16 M16 16 L8.57 23.43 M16 16 L16 26.5 M16 16 L23.43 23.43" />
        <polygon points="22.5,16 20.6,11.4 16,9.5 11.4,11.4 9.5,16 11.4,20.6 16,22.5 20.6,20.6" />
        <polygon points="26.5,16 23.43,8.57 16,5.5 8.57,8.57 5.5,16 8.57,23.43 16,26.5 23.43,23.43" />
      </g>
      <circle cx="16" cy="16" r="2.3" fill="currentColor" />
    </svg>
  );
}
