import { NextResponse } from 'next/server'
import { requireSuperAdmin } from '@/lib/auth/super-admin'
import { toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/super-admin/admin-client'

// 'pending' is deliberately not settable here — it's only ever the
// column default a new self-signup starts at (migration 045), never
// something a super admin assigns by action.
const VALID_STATUSES = new Set(['active', 'suspended', 'cancelled', 'rejected'])

/**
 * GET /api/super-admin/accounts/[id] — org detail: account, members,
 * WhatsApp connection status (boolean only — never decrypt/expose the
 * token; whatsapp_config is already UNIQUE(account_id) + AES-256-GCM
 * encrypted, so per-tenant isolation is structural, not something
 * this route needs to build), and recent status-change history.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireSuperAdmin()
  } catch (err) {
    return toErrorResponse(err)
  }

  const { id } = await params
  const admin = supabaseAdmin()

  const { data: account, error: accountError } = await admin
    .from('accounts')
    .select('id, name, status, owner_user_id, created_at, updated_at')
    .eq('id', id)
    .maybeSingle()

  if (accountError || !account) {
    return NextResponse.json({ error: 'Account not found' }, { status: 404 })
  }

  const [{ data: members }, { count: whatsappCount }, { data: auditLog }] = await Promise.all([
    admin
      .from('profiles')
      .select('user_id, full_name, email, account_role')
      .eq('account_id', id)
      .order('account_role', { ascending: false }),
    admin
      .from('whatsapp_config')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', id),
    admin
      .from('super_admin_audit_log')
      .select('id, action, metadata, created_at')
      .eq('target_account_id', id)
      .order('created_at', { ascending: false })
      .limit(20),
  ])

  return NextResponse.json({
    account,
    members: members ?? [],
    whatsapp_connected: (whatsappCount ?? 0) > 0,
    audit_log: auditLog ?? [],
  })
}

/**
 * PATCH /api/super-admin/accounts/[id] — Approve a pending
 * registration, Suspend / Reactivate for payment issues, Cancel
 * (=soft-delete), or Reject a pending registration. Single endpoint
 * for all status transitions since the account's own status enum
 * already models both soft-delete ('cancelled') and registration
 * rejection ('rejected'). Runs as service-role (current_user =
 * 'service_role'), so it passes the enforce_accounts_privilege_columns
 * trigger that blocks this exact column change for a normal
 * 'authenticated' browser client.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let ctx
  try {
    ctx = await requireSuperAdmin()
  } catch (err) {
    return toErrorResponse(err)
  }

  const { id } = await params
  const body = await request.json().catch(() => null)
  const status = body?.status

  if (typeof status !== 'string' || !VALID_STATUSES.has(status)) {
    return NextResponse.json(
      { error: 'status must be one of: active, suspended, cancelled, rejected' },
      { status: 400 },
    )
  }

  const admin = supabaseAdmin()

  // Read the prior status so the audit log can distinguish
  // "approved a pending registration" from "reactivated a suspended
  // one" — both land on status='active' but mean different things.
  const { data: before } = await admin
    .from('accounts')
    .select('status')
    .eq('id', id)
    .maybeSingle()
  const wasPending = before?.status === 'pending'

  const { data: updated, error } = await admin
    .from('accounts')
    .update({ status })
    .eq('id', id)
    .select('id, name, status')
    .maybeSingle()

  if (error || !updated) {
    return NextResponse.json({ error: error?.message ?? 'Account not found' }, { status: 404 })
  }

  const action =
    status === 'active' ? (wasPending ? 'approved' : 'reactivated') : status

  await admin.from('super_admin_audit_log').insert({
    actor_user_id: ctx.userId,
    target_account_id: id,
    action,
    metadata: { status, previous_status: before?.status ?? null },
  })

  return NextResponse.json({ account: updated })
}
