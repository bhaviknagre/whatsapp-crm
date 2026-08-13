"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { ArrowLeft, CheckCircle2, Loader2, XCircle } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type AccountStatus = "pending" | "active" | "suspended" | "cancelled" | "rejected";

interface AccountDetail {
  account: {
    id: string;
    name: string;
    status: AccountStatus;
    created_at: string;
    updated_at: string;
  };
  members: { user_id: string; full_name: string | null; email: string; account_role: string }[];
  whatsapp_connected: boolean;
  audit_log: { id: string; action: string; metadata: unknown; created_at: string }[];
}

function statusBadgeClass(status: AccountStatus): string {
  switch (status) {
    case "active":
      return "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400";
    case "pending":
      return "bg-blue-500/10 text-blue-600 dark:text-blue-400";
    case "suspended":
      return "bg-amber-500/10 text-amber-600 dark:text-amber-400";
    case "cancelled":
    case "rejected":
      return "bg-red-500/10 text-red-600 dark:text-red-400";
  }
}

export default function SuperAdminAccountDetailPage() {
  const params = useParams<{ id: string }>();
  const [data, setData] = useState<AccountDetail | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/super-admin/accounts/${params.id}`, { cache: "no-store" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json.error || "Failed to load organization.");
        return;
      }
      setData(json);
    } catch (err) {
      console.error("[SuperAdminAccountDetailPage] load error:", err);
      toast.error("Network error loading organization.");
    } finally {
      setLoading(false);
    }
  }, [params.id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="text-primary size-6 animate-spin" />
      </div>
    );
  }

  if (!data) {
    return <p className="text-sm text-muted-foreground">Organization not found.</p>;
  }

  const { account, members, whatsapp_connected, audit_log } = data;

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/super-admin"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to organizations
        </Link>
        <div className="mt-2 flex items-center gap-3">
          <h2 className="text-xl font-bold text-foreground">{account.name}</h2>
          <Badge className={cn("capitalize", statusBadgeClass(account.status))}>
            {account.status}
          </Badge>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Created {new Date(account.created_at).toLocaleString()}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="rounded-xl border border-border bg-card p-5">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            WhatsApp connection
          </p>
          <div className="mt-2 flex items-center gap-2">
            {whatsapp_connected ? (
              <>
                <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                <span className="text-sm text-foreground">Connected</span>
              </>
            ) : (
              <>
                <XCircle className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm text-muted-foreground">Not connected</span>
              </>
            )}
          </div>
        </div>
        <div className="rounded-xl border border-border bg-card p-5">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Members
          </p>
          <p className="mt-2 text-sm text-foreground">{members.length} total</p>
        </div>
      </div>

      <div>
        <h3 className="mb-2 text-sm font-semibold text-foreground">Members</h3>
        <div className="divide-y divide-border rounded-xl border border-border bg-card">
          {members.length === 0 ? (
            <p className="px-4 py-3 text-sm text-muted-foreground">No members.</p>
          ) : (
            members.map((m) => (
              <div key={m.user_id} className="flex items-center justify-between px-4 py-3">
                <div>
                  <p className="text-sm font-medium text-foreground">{m.full_name || m.email}</p>
                  <p className="text-xs text-muted-foreground">{m.email}</p>
                </div>
                <span
                  className={cn(
                    "rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium capitalize text-muted-foreground",
                  )}
                >
                  {m.account_role}
                </span>
              </div>
            ))
          )}
        </div>
      </div>

      <div>
        <h3 className="mb-2 text-sm font-semibold text-foreground">Status history</h3>
        <div className="divide-y divide-border rounded-xl border border-border bg-card">
          {audit_log.length === 0 ? (
            <p className="px-4 py-3 text-sm text-muted-foreground">No history yet.</p>
          ) : (
            audit_log.map((entry) => (
              <div key={entry.id} className="flex items-center justify-between px-4 py-3">
                <span className="text-sm capitalize text-foreground">{entry.action}</span>
                <span className="text-xs text-muted-foreground">
                  {new Date(entry.created_at).toLocaleString()}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
