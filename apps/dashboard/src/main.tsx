import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Layout } from "@/components/Layout";
import { ProxyProvider } from "@/lib/proxy";
import { ApprovalsPage } from "@/pages/Approvals";
import { DealDetailPage } from "@/pages/DealDetail";
import { DealListPage } from "@/pages/DealList";
import { MarketplacePage } from "@/pages/Marketplace";
import { ReplayPage } from "@/pages/Replay";
import { HuntPage } from "@/pages/Hunt";
import { NewDealPage } from "@/pages/NewDeal";
import { ScorecardPage } from "@/pages/Scorecard";
import "./index.css";

const queryClient = new QueryClient();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ProxyProvider>
        <BrowserRouter>
          <Routes>
            <Route path="deals/:id/replay" element={<ReplayPage />} />
            <Route element={<Layout />}>
              <Route index element={<DealListPage />} />
              <Route path="new" element={<NewDealPage />} />
              <Route path="marketplace" element={<MarketplacePage />} />
              <Route path="deals/:id" element={<DealDetailPage />} />
              <Route path="hunts/:id" element={<HuntPage />} />
              <Route path="approvals" element={<ApprovalsPage />} />
              <Route path="scorecard" element={<ScorecardPage />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </ProxyProvider>
    </QueryClientProvider>
  </StrictMode>,
);
