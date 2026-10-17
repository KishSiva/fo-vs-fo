import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const money = (n: number | null | undefined) =>
  n == null ? "—" : `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

export const time = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export const dateTime = (iso: string) =>
  new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

export function relative(iso: string) {
  const s = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  const abs = Math.abs(s);
  const fmt = abs < 60 ? `${abs}s` : abs < 3600 ? `${Math.round(abs / 60)}m` : abs < 86400 ? `${Math.round(abs / 3600)}h` : `${Math.round(abs / 86400)}d`;
  return s >= 0 ? `in ${fmt}` : `${fmt} ago`;
}

export const pct = (n: number, d: number) => (d === 0 ? "—" : `${Math.round((n / d) * 100)}%`);
