// ============================================================
// Super-admin guard — the platform-operator counterpart to
// requireRole() in src/lib/auth/account.ts. Checks profiles.is_super_admin
// (migration 044) instead of account_role; orthogonal to account
// membership entirely, since a super admin manages tenants, not one.
//
// Same calling convention as requireRole():
//   try {
//     const ctx = await requireSuperAdmin();
//     // ctx.userId — auth.uid()
//   } catch (err) {
//     return toErrorResponse(err);
//   }
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { UnauthorizedError, ForbiddenError } from "./account";

export interface SuperAdminContext {
  /** Supabase SSR client, scoped to the calling user's own session
   *  (only used here to resolve who's calling — cross-tenant reads/
   *  writes go through the service-role admin client instead). */
  supabase: SupabaseClient;
  userId: string;
}

/**
 * Resolve the caller and verify `profiles.is_super_admin = true`.
 *
 * Throws `UnauthorizedError` if there's no session, `ForbiddenError`
 * if the caller isn't a super admin. Route-level enforcement — the
 * `/super-admin/*` gate in `src/proxy.ts` is a UX shortcut, not the
 * authorization boundary; every API route under `/api/super-admin/*`
 * must call this independently.
 */
export async function requireSuperAdmin(): Promise<SuperAdminContext> {
  const supabase = await createClient();

  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser();
  if (userErr || !user) {
    throw new UnauthorizedError();
  }

  const { data, error } = await supabase
    .from("profiles")
    .select("is_super_admin")
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) {
    console.error("[requireSuperAdmin] profile fetch error:", error);
    throw new ForbiddenError("Could not verify super admin access");
  }
  if (!data?.is_super_admin) {
    throw new ForbiddenError("Super admin access required");
  }

  return { supabase, userId: user.id };
}
