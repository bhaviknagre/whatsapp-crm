import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { ShieldAlert } from "lucide-react";
import { requireSuperAdmin } from "@/lib/auth/super-admin";

// Standalone platform-operator shell — deliberately NOT the tenant-
// facing DashboardShell/sidebar (this is a different audience: the
// platform operator managing client organizations, not a tenant
// managing their own CRM). src/proxy.ts already redirects non-super-
// admins away from /super-admin/* as a UX shortcut; this server-side
// check is the actual authorization boundary (proxy explicitly
// disclaims being "a full session management or authorization
// solution" per Next's own docs).

export const metadata: Metadata = {
  robots: { index: false, follow: false, nocache: true },
};

export default async function SuperAdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  let authorized = false;
  try {
    await requireSuperAdmin();
    authorized = true;
  } catch {
    authorized = false;
  }
  // redirect() throws internally — must not be inside the try/catch
  // above, or its own throw gets swallowed as "unauthorized".
  if (!authorized) redirect("/dashboard");

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border bg-card px-6 py-4">
        <div className="flex items-center gap-2">
          <ShieldAlert className="h-4 w-4 text-primary" />
          <span className="text-sm font-semibold">Platform Admin</span>
        </div>
      </header>
      <main className="mx-auto max-w-5xl p-6">{children}</main>
    </div>
  );
}
