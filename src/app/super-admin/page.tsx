"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Check, Loader2, Plus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

type AccountStatus = "pending" | "active" | "suspended" | "cancelled" | "rejected";

interface AccountRow {
  id: string;
  name: string;
  status: AccountStatus;
  created_at: string;
  member_count: number;
  owner: { full_name: string | null; email: string } | null;
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

export default function SuperAdminAccountsPage() {
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [updating, setUpdating] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/super-admin/accounts", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error || "Failed to load organizations.");
        return;
      }
      setAccounts(data.accounts ?? []);
    } catch (err) {
      console.error("[SuperAdminAccountsPage] load error:", err);
      toast.error("Network error loading organizations.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function setStatus(account: AccountRow, status: AccountStatus) {
    setUpdating(account.id);
    try {
      const res = await fetch(`/api/super-admin/accounts/${account.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error || "Failed to update status.");
        return;
      }
      setAccounts((prev) => prev.map((a) => (a.id === account.id ? { ...a, status } : a)));
      toast.success(`${account.name} is now ${status}.`);
    } catch (err) {
      console.error("[SuperAdminAccountsPage] status update error:", err);
      toast.error("Network error updating status.");
    } finally {
      setUpdating(null);
    }
  }

  const pendingAccounts = accounts.filter((a) => a.status === "pending");
  const otherAccounts = accounts.filter((a) => a.status !== "pending");

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-foreground">Client Organizations</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {accounts.length} organization{accounts.length === 1 ? "" : "s"}
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="size-4" />
          New Client
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="text-primary size-6 animate-spin" />
        </div>
      ) : (
        <>
          {pendingAccounts.length > 0 && (
            <div className="rounded-xl border border-blue-500/30 bg-blue-500/5">
              <div className="border-b border-blue-500/20 px-4 py-3">
                <h3 className="text-sm font-semibold text-foreground">
                  Pending registration requests ({pendingAccounts.length})
                </h3>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  New self-signups awaiting approval before they can access the platform.
                </p>
              </div>
              <ul className="divide-y divide-border">
                {pendingAccounts.map((a) => (
                  <li key={a.id} className="flex items-center justify-between gap-3 px-4 py-3">
                    <div className="min-w-0">
                      <Link href={`/super-admin/${a.id}`} className="text-sm font-medium text-foreground hover:underline">
                        {a.name}
                      </Link>
                      <p className="truncate text-xs text-muted-foreground">
                        {a.owner?.full_name || a.owner?.email || "—"} · signed up{" "}
                        {new Date(a.created_at).toLocaleDateString()}
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-1.5">
                      <Button
                        size="sm"
                        disabled={updating === a.id}
                        onClick={() => setStatus(a, "active")}
                      >
                        <Check className="size-3.5" />
                        Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={updating === a.id}
                        onClick={() => setStatus(a, "rejected")}
                        className="border-red-500/40 text-red-600 hover:bg-red-500/10 dark:text-red-400"
                      >
                        <X className="size-3.5" />
                        Reject
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {otherAccounts.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {pendingAccounts.length === 0 ? "No organizations yet." : "No other organizations yet."}
            </p>
          ) : (
        <div className="rounded-xl border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Organization</TableHead>
                <TableHead>Owner</TableHead>
                <TableHead>Members</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {otherAccounts.map((a) => (
                <TableRow key={a.id}>
                  <TableCell className="font-medium">
                    <Link href={`/super-admin/${a.id}`} className="hover:underline">
                      {a.name}
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {a.owner?.full_name || a.owner?.email || "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{a.member_count}</TableCell>
                  <TableCell>
                    <span
                      className={cn(
                        "rounded-full px-2 py-0.5 text-[11px] font-medium capitalize",
                        statusBadgeClass(a.status),
                      )}
                    >
                      {a.status}
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {new Date(a.created_at).toLocaleDateString()}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      {a.status !== "active" && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={updating === a.id}
                          onClick={() => setStatus(a, "active")}
                        >
                          Reactivate
                        </Button>
                      )}
                      {a.status !== "suspended" && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={updating === a.id}
                          onClick={() => setStatus(a, "suspended")}
                        >
                          Suspend
                        </Button>
                      )}
                      {a.status !== "cancelled" && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={updating === a.id}
                          onClick={() => {
                            if (
                              window.confirm(
                                `Cancel ${a.name}? This ends their access immediately.`,
                              )
                            ) {
                              void setStatus(a, "cancelled");
                            }
                          }}
                          className="border-red-500/40 text-red-600 hover:bg-red-500/10 dark:text-red-400"
                        >
                          Cancel
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
          )}
        </>
      )}

      <CreateClientDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={load}
      />
    </div>
  );
}

function CreateClientDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const [orgName, setOrgName] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [adminName, setAdminName] = useState("");
  const [saving, setSaving] = useState(false);

  function reset() {
    setOrgName("");
    setAdminEmail("");
    setAdminName("");
  }

  async function handleCreate() {
    if (!orgName.trim()) {
      toast.error("Organization name is required.");
      return;
    }
    if (!adminEmail.trim()) {
      toast.error("Admin email is required.");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/super-admin/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          org_name: orgName.trim(),
          admin_email: adminEmail.trim(),
          admin_full_name: adminName.trim() || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error || "Failed to create client.");
        return;
      }
      toast.success(`${orgName} created — invite email sent to ${adminEmail}.`);
      reset();
      onOpenChange(false);
      onCreated();
    } catch (err) {
      console.error("[CreateClientDialog] create error:", err);
      toast.error("Network error creating client.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-border bg-popover sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">New client organization</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            Sends a Supabase invite email to the admin — accepting it creates their account
            automatically, which is then renamed to the organization name below.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="org-name" className="text-muted-foreground">
              Organization name
            </Label>
            <Input
              id="org-name"
              value={orgName}
              onChange={(e) => setOrgName(e.target.value)}
              placeholder="Acme Inc."
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="admin-email" className="text-muted-foreground">
              Admin email
            </Label>
            <Input
              id="admin-email"
              type="email"
              value={adminEmail}
              onChange={(e) => setAdminEmail(e.target.value)}
              placeholder="admin@acme.com"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="admin-name" className="text-muted-foreground">
              Admin name (optional)
            </Label>
            <Input
              id="admin-name"
              value={adminName}
              onChange={(e) => setAdminName(e.target.value)}
              placeholder="Jane Doe"
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="border-border text-muted-foreground hover:bg-muted"
          >
            Cancel
          </Button>
          <Button onClick={handleCreate} disabled={saving}>
            {saving && <Loader2 className="size-4 animate-spin" />}
            Create client
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
