import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap",
  {
    variants: {
      variant: {
        default: "border-slate-200 bg-slate-100 text-slate-700",
        dark: "border-transparent bg-slate-900 text-white",
        green: "border-emerald-200 bg-emerald-50 text-emerald-700",
        red: "border-red-200 bg-red-50 text-red-700",
        amber: "border-amber-200 bg-amber-50 text-amber-800",
        blue: "border-sky-200 bg-sky-50 text-sky-700",
        violet: "border-violet-200 bg-violet-50 text-violet-700",
        outline: "border-slate-300 bg-white text-slate-700",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
