import { ChevronRight } from "lucide-react";
import { Link, Navigate } from "react-router-dom";
import { CounterpartyLine } from "@/components/DealHeader";
import { Empty, QueryState, StageBadge, StatusBadge } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { useDeals } from "@/lib/api";
import { dateTime } from "@/lib/utils";

export function DealListPage() {
  const { data, isPending, error } = useDeals();
  if (data?.length === 1) return <Navigate to={`/deals/${data[0].id}`} replace />;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Deals</CardTitle>
      </CardHeader>
      <QueryState isPending={isPending} error={error}>
        {!data?.length ? (
          <Empty>No deals on this proxy yet.</Empty>
        ) : (
          <ul className="divide-y divide-slate-100">
            {data.map((d) => (
              <li key={d.id}>
                <Link to={`/deals/${d.id}`} className="flex items-center gap-4 px-4 py-3 hover:bg-slate-50">
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">{d.item}</div>
                    <CounterpartyLine deal={d} />
                  </div>
                  {d.huntId && <Badge variant="blue" title="One of several sellers in a search">search {d.huntId}</Badge>}
                  <StageBadge stage={d.stage} />
                  <StatusBadge status={d.status} />
                  <span className="w-28 text-right text-xs text-slate-500">{dateTime(d.createdAt)}</span>
                  <ChevronRight className="h-4 w-4 text-slate-400" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </QueryState>
    </Card>
  );
}
