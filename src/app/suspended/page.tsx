"use client";

// Non-active account notice — covers all four states a signed-in
// user's account can be in besides 'active': pending (new self-signup
// awaiting super-admin approval), suspended (payment issue), cancelled,
// rejected. Deliberately NOT under the (dashboard) route group — it
// must never trigger DashboardShell's own protected-data fetches
// (those would just come back empty, since RLS denies everything for
// a non-active account — see src/hooks/use-auth.tsx's AccountStatus
// doc comment). Reachable for a signed-in user without needing any
// tenant-scoped data at all.

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { Ban, Clock, CreditCard, XCircle, type LucideIcon } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { AccountLifecycleStatus } from "@/hooks/use-auth";

// useSearchParams opts this page out of static prerendering unless it
// sits under a Suspense boundary — same split as the login page.
export default function SuspendedPage() {
  return (
    <Suspense fallback={null}>
      <SuspendedPageInner />
    </Suspense>
  );
}

const STATUS_COPY: Record<
  Exclude<AccountLifecycleStatus, "active">,
  { icon: LucideIcon; title: string; body: string }
> = {
  pending: {
    icon: Clock,
    title: "Your registration is under review",
    body: "Thanks for signing up. An administrator needs to approve your account before you can access the workspace — you'll be able to sign in as soon as that happens.",
  },
  suspended: {
    icon: CreditCard,
    title: "Your account is suspended",
    body: "Your account subscription is currently suspended, most likely due to a missed payment. Please contact support to update your billing and restore access.",
  },
  cancelled: {
    icon: Ban,
    title: "This account has been cancelled",
    body: "Access to this workspace has been permanently ended. Contact support if you believe this is a mistake.",
  },
  rejected: {
    icon: XCircle,
    title: "Your registration was not approved",
    body: "An administrator reviewed your registration and it wasn't approved for access. Contact support if you have questions.",
  },
};

function SuspendedPageInner() {
  const searchParams = useSearchParams();
  const rawStatus = searchParams.get("status");
  const status: Exclude<AccountLifecycleStatus, "active"> =
    rawStatus && rawStatus in STATUS_COPY
      ? (rawStatus as Exclude<AccountLifecycleStatus, "active">)
      : "suspended";
  const copy = STATUS_COPY[status];
  const Icon = copy.icon;

  async function handleSignOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    window.location.href = "/login";
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardContent className="flex flex-col items-center gap-4 p-8 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
            <Icon className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-foreground">{copy.title}</h1>
            <p className="mt-2 text-sm text-muted-foreground">{copy.body}</p>
          </div>
          <Button variant="outline" onClick={handleSignOut} className="mt-2">
            Sign out
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
