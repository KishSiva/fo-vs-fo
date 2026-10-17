import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Layout } from "@/components/Layout";
import { ProxyProvider } from "@/lib/proxy";
import { ApprovalsPage } from "@/pages/Approvals";
import { DealDetailPage } from "@/pages/DealDetail";
import { DealListPage } from "@/pages/DealList";
import { ScorecardPage } from "@/pages/Scorecard";
import "./index.css";

const queryClient = new QueryClient();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ProxyProvider>
        <BrowserRouter>
          <Routes>
            <Route element={<Layout />}>
              <Route index element={<DealListPage />} />
              <Route path="deals/:id" element={<DealDetailPage />} />
              <Route path="approvals" element={<ApprovalsPage />} />
              <Route path="scorecard" element={<ScorecardPage />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </ProxyProvider>
    </QueryClientProvider>
  </StrictMode>,
);
