import { Handshake } from "lucide-react";
import { NavLink, Outlet } from "react-router-dom";
import { useHealth, usePendingApprovals } from "@/lib/api";
import { PROXIES, useProxy } from "@/lib/proxy";
import { cn, relative } from "@/lib/utils";
import { Badge } from "./ui/badge";

function HealthDot() {
  const { data, isError, isPending } = useHealth();
  const color = isPending ? "bg-slate-300" : isError ? "bg-red-500" : "bg-emerald-500";
  const label = isPending ? "Connecting…" : isError ? "Offline" : "Online";
  const beat = data?.worker.lastBeat;
  return (
    <div className="flex items-center gap-2 text-xs text-slate-600" title={beat ? `Worker heartbeat ${relative(beat)}` : undefined}>
      <span className="relative flex h-2.5 w-2.5">
        {!isError && !isPending && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />}
        <span className={cn("relative inline-flex h-2.5 w-2.5 rounded-full", color)} />
      </span>
      <span className="font-medium">{label}</span>
      {data && (
        <>
          <span className="text-slate-400">·</span>
          <span>
            {data.owner} <span className="text-slate-400">({data.role})</span>
          </span>
          <Badge variant={data.foSignedIn ? "green" : "red"}>{data.foSignedIn ? "Fo signed in" : "Fo signed out"}</Badge>
        </>
      )}
    </div>
  );
}

function ProxySelect() {
  const { proxy, setProxyUrl } = useProxy();
  return (
    <select
      value={proxy.url}
      onChange={(e) => setProxyUrl(e.target.value)}
      className="h-8 rounded-md border border-slate-300 bg-white px-2 text-sm font-medium shadow-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
      aria-label="Select proxy"
    >
      {PROXIES.map((p) => (
        <option key={p.url} value={p.url}>
          {p.name} — {p.url.replace(/^https?:\/\//, "")}
        </option>
      ))}
    </select>
  );
}

function NavItem({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <NavLink
      to={to}
      end={to === "/"}
      className={({ isActive }) =>
        cn(
          "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100",
          isActive && "bg-slate-900 text-white hover:bg-slate-900",
        )
      }
    >
      {children}
    </NavLink>
  );
}

export function Layout() {
  const approvals = usePendingApprovals();
  const pending = approvals.data?.length ?? 0;
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-[1500px] flex-wrap items-center gap-4 px-4 py-2.5">
          <NavLink to="/" className="flex items-center gap-2 font-semibold tracking-tight">
            <Handshake className="h-5 w-5 text-sky-600" />
            ProxyDeal
          </NavLink>
          <nav className="flex items-center gap-1">
            <NavItem to="/">Deals</NavItem>
            <NavItem to="/approvals">
              Approvals
              {pending > 0 && (
                <span className="rounded-full bg-amber-500 px-1.5 text-[11px] font-bold leading-4 text-white">{pending}</span>
              )}
            </NavItem>
            <NavItem to="/scorecard">Scorecard</NavItem>
          </nav>
          <div className="ml-auto flex flex-wrap items-center gap-4">
            <HealthDot />
            <ProxySelect />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-[1500px] px-4 py-5">
        <Outlet />
      </main>
    </div>
  );
}
