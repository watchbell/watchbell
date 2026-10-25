import { cn } from "@/lib/utils";

/**
 * The Watchbell mark: a yellow bell, tilted as it rings, on a navy square (the same drawing as app/icon.svg).
 * The colours are fixed in both themes; in dark mode the square gets a faint edge so it stays visible on a dark page.
 * Decorative by default (aria-hidden); pass `title` when the mark is the only thing naming the link or page.
 */
export function BellMark({ size = 28, title, className }: { size?: number; title?: string; className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 32 32"
      width={size}
      height={size}
      className={cn("shrink-0", className)}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {title ? <title>{title}</title> : null}
      <rect
        x="0.5" y="0.5" width="31" height="31" rx="7" fill="#14213d"
        strokeWidth="1" className="stroke-transparent dark:stroke-[#2f4372]"
      />
      <g transform="rotate(-14 15 16)" fill="#fcc419">
        <rect x="13.7" y="5.4" width="2.6" height="2.4" rx="1.1" />
        <path d="M15 7.2c-4.3 0-6.8 3.1-6.8 7.3v4.1l-2.4 3.3h18.4l-2.4-3.3v-4.1c0-4.2-2.5-7.3-6.8-7.3z" />
        <circle cx="15" cy="24.3" r="2.3" />
      </g>
      <g fill="none" stroke="#fcc419" strokeWidth="2.2" strokeLinecap="round">
        <path d="M24.4 9.2c1.4 1.4 2.2 3.2 2.2 5.2" />
        <path d="M22.8 11.1c.8.8 1.2 1.8 1.2 2.9" />
      </g>
    </svg>
  );
}
