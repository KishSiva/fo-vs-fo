import { createContext, useContext, useState, type ReactNode } from "react";

export interface ProxyOption {
  name: string;
  url: string;
}

const DEFAULT_PROXIES: ProxyOption[] = [
  { name: "Agent 1 (seller)", url: "http://localhost:4001" },
  { name: "Agent 2 (buyer)", url: "http://localhost:4002" },
];

function loadProxies(): ProxyOption[] {
  const raw = import.meta.env.VITE_PROXIES as string | undefined;
  if (!raw) return DEFAULT_PROXIES;
  try {
    const list = JSON.parse(raw);
    if (Array.isArray(list) && list.length && list.every((p) => p?.name && p?.url)) return list;
  } catch {
    /* fall through */
  }
  console.warn("Invalid VITE_PROXIES, using defaults");
  return DEFAULT_PROXIES;
}

export const PROXIES = loadProxies();
const STORAGE_KEY = "proxydeal.proxyUrl";

interface ProxyCtx {
  proxy: ProxyOption;
  setProxyUrl: (url: string) => void;
}

const Ctx = createContext<ProxyCtx | null>(null);

export function ProxyProvider({ children }: { children: ReactNode }) {
  const [url, setUrl] = useState(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    return PROXIES.some((p) => p.url === saved) ? saved! : PROXIES[0].url;
  });
  const proxy = PROXIES.find((p) => p.url === url) ?? PROXIES[0];
  const setProxyUrl = (next: string) => {
    localStorage.setItem(STORAGE_KEY, next);
    setUrl(next);
  };
  return <Ctx.Provider value={{ proxy, setProxyUrl }}>{children}</Ctx.Provider>;
}

export function useProxy() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useProxy outside ProxyProvider");
  return ctx;
}
