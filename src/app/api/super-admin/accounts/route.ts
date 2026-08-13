import { NextResponse } from 'next/server'
import { requireSuperAdmin } from '@/lib/auth/super-admin'
import { toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/super-admin/admin-client'

/**
 * GET /api/super-admin/accounts
 *
 * List every tenant account with owner + member-count info, for the
 * super-admin org list. Cross-tenant by design — service-role client,
 * gated by requireSuperAdmin() rather than RLS (accounts_select is
 * membership-scoped and would only ever show the caller's own org).
 */
export async function GET() {
  try {
    await requireSuperAdmin()
  } catch (err) {
    return toErrorResponse(err)
  }

  const admin = supabaseAdmin()

  const { data: accounts, error } = await admin
    .from('accounts')
    .select('id, name, status, owner_user_id, created_at')
    .order('created_at', { ascending: false })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  if (!accounts || accounts.length === 0) {
    return NextResponse.json({ accounts: [] })
  }

  const accountIds = accounts.map((a) => a.id)
  const { data: profiles } = await admin
    .from('profiles')
    .select('user_id, full_name, email, account_id')
    .in('account_id', accountIds)

  const profileRows = (profiles ?? []) as {
    user_id: string
    full_name: string | null
    email: string
    account_id: string
  }[]

  const memberCountByAccount = new Map<string, number>()
  const ownerByUserId = new Map<string, { full_name: string | null; email: string }>()
  for (const p of profileRows) {
    memberCountByAccount.set(p.account_id, (memberCountByAccount.get(p.account_id) ?? 0) + 1)
    ownerByUserId.set(p.user_id, { full_name: p.full_name, email: p.email })
  }

  const result = accounts.map((a) => ({
    id: a.id,
    name: a.name,
    status: a.status,
    created_at: a.created_at,
    member_count: memberCountByAccount.get(a.id) ?? 0,
    owner: ownerByUserId.get(a.owner_user_id) ?? null,
  }))

  return NextResponse.json({ accounts: result })
}

/**
 * POST /api/super-admin/accounts — Create Client.
 *
 * Body: { org_name, admin_email, admin_full_name? }
 *
 * Uses Supabase's built-in inviteUserByEmail (service role), which
 * creates the auth.users row immediately and fires the EXISTING
 * handle_new_user trigger — that trigger auto-creates a personal
 * account with the invited user as owner. This route then renames
 * that account to org_name. No parallel "create org" schema/RPC
 * needed; reuses the exact same bootstrap every normal signup goes
 * through.
 */
export async function POST(request: Request) {
  let ctx
  try {
    ctx = await requireSuperAdmin()
  } catch (err) {
    return toErrorResponse(err)
  }

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

  const orgName = typeof body.org_name === 'string' ? body.org_name.trim() : ''
  const adminEmail = typeof body.admin_email === 'string' ? body.admin_email.trim() : ''
  const adminFullName = typeof body.admin_full_name === 'string' ? body.admin_full_name.trim() : ''

  if (!orgName) return NextResponse.json({ error: 'org_name is required' }, { status: 400 })
  if (!adminEmail) return NextResponse.json({ error: 'admin_email is required' }, { status: 400 })

  const admin = supabaseAdmin()

  const { data: inviteData, error: inviteError } = await admin.auth.admin.inviteUserByEmail(
    adminEmail,
    { data: adminFullName ? { full_name: adminFullName } : undefined },
  )

  if (inviteError) {
    // GoTrue rejects with 422/"already registered" if this email
    // already has an auth.users row — the one-account-per-user
    // invariant (idx_accounts_one_per_owner) means they can't become
    // the owner of a second account through this flow.
    if (inviteError.status === 422 || /already.*registered/i.test(inviteError.message)) {
      return NextResponse.json(
        { error: `${adminEmail} is already registered to an account on this platform.` },
        { status: 409 },
      )
    }
    console.error('[super-admin] inviteUserByEmail failed:', inviteError.message)
    return NextResponse.json({ error: `Failed to invite admin: ${inviteError.message}` }, { status: 500 })
  }

  const newUserId = inviteData.user?.id
  if (!newUserId) {
    return NextResponse.json({ error: 'Invite succeeded but returned no user id' }, { status: 500 })
  }

  // handle_new_user() swallows its own exceptions (RAISE WARNING, not
  // an error that would roll back the auth.users insert or bubble
  // here) — verify the account bootstrap actually happened rather
  // than assuming success because the invite call returned.
  const { data: newAccount, error: acctLookupError } = await admin
    .from('accounts')
    .select('id')
    .eq('owner_user_id', newUserId)
    .maybeSingle()

  if (acctLookupError || !newAccount) {
    console.error('[super-admin] account bootstrap did not complete for', newUserId, acctLookupError)
    return NextResponse.json(
      {
        error:
          'The admin was invited (email sent) but their account setup failed to complete. Check Supabase Auth users / logs, or contact support before retrying.',
      },
      { status: 500 },
    )
  }

  // Rename to the org name and set status='active' explicitly —
  // accounts.status now DEFAULTS to 'pending' (migration 045, for
  // self-signup approval), but a super admin directly provisioning a
  // client IS the vetting; there's nothing to self-approve.
  const { error: renameError } = await admin
    .from('accounts')
    .update({ name: orgName, status: 'active' })
    .eq('id', newAccount.id)

  if (renameError) {
    console.error('[super-admin] account rename failed:', renameError.message)
  }

  await admin.from('super_admin_audit_log').insert({
    actor_user_id: ctx.userId,
    target_account_id: newAccount.id,
    action: 'created',
    metadata: { org_name: orgName, admin_email: adminEmail },
  })

  return NextResponse.json(
    { account: { id: newAccount.id, name: orgName, owner_email: adminEmail } },
    { status: 201 },
  )
}
