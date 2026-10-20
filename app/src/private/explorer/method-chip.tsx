import { cn } from "@/lib/utils";

// The mockup's .meth chip: GET teal, POST brand blue, HEAD grey.
const TONE = { get: "bg-teal-soft text-teal", post: "bg-brand-soft text-brand", head: "bg-gray-soft text-ink-soft" } as const;

export function MethodChip({ method, className }: { method: keyof typeof TONE; className?: string }) {
  return (
    <span className={cn("inline-block min-w-[46px] rounded-[4px] px-[5px] py-px text-center font-mono text-[11px] font-medium", TONE[method], className)}>
      {method.toUpperCase()}
    </span>
  );
}
