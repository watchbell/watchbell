import { IconInbox, type Icon as TablerIcon } from "@tabler/icons-react";
import Link from "next/link";
import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";
import { MaskedText } from "@/components/alias";
import { StateIcon } from "@/components/status";
import { clampPct } from "@/lib/status";
import { cn } from "@/lib/utils";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

export function buttonClass({ variant = "secondary", size = "md" }: { variant?: Variant; size?: Size } = {}) {
  return cn(
    "inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border transition-colors disabled:cursor-not-allowed disabled:opacity-60 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40",
    size === "sm" ? "px-[9px] py-[3px] text-[13px]" : "px-3 py-1.5",
    variant === "primary" && "border-brand bg-brand text-on-brand hover:bg-brand-hover",
    variant === "secondary" && "border-line-strong bg-surface text-ink hover:bg-hover",
    variant === "ghost" && "border-transparent bg-transparent text-brand hover:bg-brand-soft",
    variant === "danger" && "border-err bg-err text-on-brand hover:brightness-95",
  );
}

export function Button({
  variant, size, className, type = "button", ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }) {
  return <button type={type} className={cn(buttonClass({ variant, size }), className)} {...props} />;
}

export function IconButton({
  label, pressed, children, ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; pressed?: boolean; ref?: Ref<HTMLButtonElement> }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      className={cn(
        "relative inline-grid size-[34px] place-items-center rounded-md text-ink-soft hover:bg-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40",
        pressed && "bg-brand-soft text-brand",
      )}
      {...props}
    >
      {children}
    </button>
  );
}

export function Card({
  title, meta, flush, className, children,
}: { title?: ReactNode; meta?: ReactNode; flush?: boolean; className?: string; children: ReactNode }) {
  return (
    <section className={cn("min-w-0 rounded-lg border border-line bg-surface", className)}>
      {title && (
        <div className={cn("flex flex-wrap items-center gap-2 px-[18px] pt-3.5", flush ? "pb-2.5" : "pb-1.5")}>
          <h2 className="text-[15px]">{title}</h2>
          {meta && <span className="ml-auto flex items-center gap-1.5 text-[12.5px] text-ink-soft">{meta}</span>}
        </div>
      )}
      {flush ? children : <div className="px-[18px] pb-4 pt-2">{children}</div>}
    </section>
  );
}

const BANNER = {
  danger: { box: "bg-err-soft border-err/30", state: "err" },
  warning: { box: "bg-warn-soft border-warn-icon/35", state: "warn" },
  info: { box: "bg-brand-soft border-brand/25", state: "info" },
} as const;

// Screenshot mode: plain-text titles and bodies mask the names, hosts and emails in them (components/alias.tsx).
const masked = (n: ReactNode, inLink?: boolean) => (typeof n === "string" ? <MaskedText text={n} inLink={inLink} /> : n);

export function Banner({
  tone, title, children, action,
}: { tone: keyof typeof BANNER; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  const t = BANNER[tone];
  return (
    <div className={cn("flex items-start gap-2.5 rounded-lg border px-3.5 py-2.5", t.box)} role={tone === "danger" ? "alert" : "status"}>
      <span className="mt-px"><StateIcon state={t.state} size={18} /></span>
      <div>
        <b className="block font-medium">{masked(title)}</b>
        {children && <p className="mt-0.5 text-[13px] text-ink-soft">{masked(children)}</p>}
      </div>
      {action && <div className="ml-auto">{action}</div>}
    </div>
  );
}

export function EmptyState({
  icon: Icon = IconInbox, title, children, action,
}: { icon?: TablerIcon; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="px-4 py-7 text-center text-ink-soft">
      <Icon size={28} aria-hidden className="mx-auto text-ink-faint" />
      <b className="mb-0.5 mt-1.5 block font-medium text-ink">{title}</b>
      {children}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

export function Progress({ pct, tone }: { pct: number; tone?: "warn" | "err" }) {
  return (
    <div className="mt-[5px] h-[5px] min-w-[110px] overflow-hidden rounded-[3px] bg-sunken">
      <div
        className={cn("h-full rounded-[3px] bg-brand", tone === "warn" && "bg-warn-icon", tone === "err" && "bg-err")}
        style={{ width: `${clampPct(pct)}%` }}
      />
    </div>
  );
}

export function Field({
  id, label, help, error, children,
}: { id: string; label: ReactNode; help?: ReactNode; error?: string; children: ReactNode }) {
  return (
    <div className="mb-3.5 flex flex-col gap-[5px]">
      <label htmlFor={id} className="text-[13px] font-medium">{label}</label>
      {children}
      {help && <span className="text-[12.5px] text-ink-soft">{help}</span>}
      {error && <span className="text-[12.5px] text-err" role="alert">{error}</span>}
    </div>
  );
}

export const fieldClass =
  "w-full rounded-md border border-line-strong bg-surface px-2.5 py-1.5 text-ink outline-none focus:border-brand focus:ring-2 focus:ring-brand/40";

export type Crumb = { label: string; href?: string };

export function PageHeader({
  crumbs, title, badge, sub, actions,
}: { crumbs: Crumb[]; title: ReactNode; badge?: ReactNode; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div>
      <div className="text-[12.5px] text-ink-faint">
        {crumbs.map((c, i) => (
          <span key={`${c.label}-${i}`}>
            {i > 0 && " / "}
            {c.href ? <Link href={c.href} className="text-ink-soft">{masked(c.label, true)}</Link> : masked(c.label)}
          </span>
        ))}
      </div>
      <div className="flex flex-wrap items-start gap-3">
        <div>
          <h1 className="flex items-center gap-2.5 text-[22px]">{badge}{masked(title)}</h1>
          {sub && <p className="mt-1 max-w-[820px] text-ink-soft">{sub}</p>}
        </div>
        {actions && <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

// The mockup's `.label`: a small grey bordered tag (Current, Production, Preview, an event's type).
export function Tag({ children }: { children: ReactNode }) {
  return <span className="mr-1 inline-block rounded-[5px] border border-line bg-surface-2 px-1.5 text-xs text-ink-soft">{children}</span>;
}

// R4: an action the mockup shows that a later stage makes real. The wrapper carries the tooltip, because a disabled
// button does not receive the hover that shows one; the aria-label gives assistive tech the stage.
export function LaterButton({ label, stage, variant = "secondary" }: { label: string; stage: number; variant?: "secondary" | "ghost" }) {
  return (
    <span title={`Arrives in stage ${stage}`} className="inline-flex">
      <Button size="sm" variant={variant} disabled aria-label={`${label}, arrives in stage ${stage}`}>{label}</Button>
    </span>
  );
}
