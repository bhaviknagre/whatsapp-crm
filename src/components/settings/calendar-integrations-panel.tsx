'use client';

// ============================================================
// Settings → Booking → Calendar integrations
//
// Lets an admin connect Cal.com: generates an unguessable webhook URL
// (paste into Cal.com → Settings → Developer → Webhooks), collects the
// signing secret Cal.com shows when the webhook is created, and an
// optional default reschedule link used in no-show follow-ups.
//
// Google Calendar is shown as a disabled "Coming soon" row — the DB
// schema already has room for it, but the OAuth consent flow isn't
// wired up yet (push notifications carry no event data, so reading a
// changed event needs a stored, refreshable per-account credential —
// a materially larger, separate effort from Cal.com's webhook model).
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Calendar, Copy, Loader2, RefreshCw } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RequireRole } from '@/components/auth/require-role';
import { SettingsPanelHead } from './settings-panel-head';

interface Integration {
  id: string;
  provider: 'cal_com' | 'google_calendar';
  webhook_url: string | null;
  default_reschedule_url: string | null;
  is_active: boolean;
  has_webhook_secret: boolean;
  is_connected: boolean;
}

export function CalendarIntegrationsPanel() {
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [loading, setLoading] = useState(true);
  const [secret, setSecret] = useState('');
  const [rescheduleUrl, setRescheduleUrl] = useState('');
  const [saving, setSaving] = useState(false);
  const [rotating, setRotating] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/settings/calendar-integrations', { cache: 'no-store' });
      if (!res.ok) {
        toast.error('Failed to load calendar integrations.');
        return;
      }
      const data = (await res.json()) as { integrations: Integration[] };
      setIntegrations(data.integrations);
      const cal = data.integrations.find((i) => i.provider === 'cal_com');
      if (cal) setRescheduleUrl(cal.default_reschedule_url ?? '');
    } catch (err) {
      console.error('[CalendarIntegrationsPanel] load error:', err);
      toast.error('Network error loading calendar integrations.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const calIntegration = integrations.find((i) => i.provider === 'cal_com') ?? null;

  async function handleSave() {
    if (!calIntegration && !secret.trim()) {
      toast.error('Paste the signing secret Cal.com shows when you create the webhook.');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/settings/calendar-integrations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'cal_com',
          webhook_secret: secret.trim() || undefined,
          default_reschedule_url: rescheduleUrl.trim() || null,
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(payload.error || 'Failed to save.');
        return;
      }
      toast.success('Cal.com integration saved.');
      setSecret('');
      await load();
    } catch (err) {
      console.error('[CalendarIntegrationsPanel] save error:', err);
      toast.error('Network error.');
    } finally {
      setSaving(false);
    }
  }

  async function handleRotate() {
    if (!calIntegration) return;
    setRotating(true);
    try {
      const res = await fetch(
        `/api/settings/calendar-integrations/${calIntegration.id}/rotate-token`,
        { method: 'POST' },
      );
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(payload.error || 'Failed to rotate the webhook URL.');
        return;
      }
      toast.success('Webhook URL rotated — update it in Cal.com.');
      await load();
    } catch (err) {
      console.error('[CalendarIntegrationsPanel] rotate error:', err);
      toast.error('Network error.');
    } finally {
      setRotating(false);
    }
  }

  async function copyUrl(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      toast.success('Webhook URL copied.');
    } catch {
      toast.error('Copy failed — select and copy manually.');
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="text-primary size-6 animate-spin" />
      </div>
    );
  }

  return (
    <section className="animate-in fade-in-50 space-y-6 duration-200">
      <SettingsPanelHead
        title="Booking & calendar"
        description="Connect a calendar tool so bookings automatically send WhatsApp confirmations, reminders, and no-show follow-ups."
      />

      <Card>
        <CardContent className="space-y-4 p-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Calendar className="text-muted-foreground size-4" />
              <span className="text-foreground text-sm font-medium">Cal.com</span>
              {calIntegration?.is_connected && (
                <Badge className="border-border bg-muted text-muted-foreground text-[10px] tracking-wide uppercase">
                  Connected
                </Badge>
              )}
            </div>
          </div>

          {calIntegration?.webhook_url && (
            <div className="space-y-1.5">
              <Label className="text-muted-foreground">
                Webhook URL — paste into Cal.com → Settings → Developer → Webhooks
              </Label>
              <div className="flex gap-2">
                <Input readOnly value={calIntegration.webhook_url} className="font-mono text-xs" />
                <Button type="button" variant="outline" onClick={() => copyUrl(calIntegration.webhook_url!)}>
                  <Copy className="size-4" />
                  Copy
                </Button>
                <RequireRole min="admin">
                  <Button type="button" variant="outline" onClick={handleRotate} disabled={rotating}>
                    {rotating ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                    Rotate
                  </Button>
                </RequireRole>
              </div>
              <p className="text-muted-foreground text-xs">
                Rotating invalidates the old URL immediately — update Cal.com right after.
              </p>
            </div>
          )}

          <RequireRole min="admin">
            <div className="space-y-1.5">
              <Label htmlFor="cal-webhook-secret" className="text-muted-foreground">
                {calIntegration?.has_webhook_secret ? 'Signing secret (leave blank to keep the current one)' : 'Signing secret'}
              </Label>
              <Input
                id="cal-webhook-secret"
                type="password"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                placeholder={calIntegration?.has_webhook_secret ? '••••••••' : 'Paste the secret Cal.com generated'}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="cal-reschedule-url" className="text-muted-foreground">
                Default reschedule link
              </Label>
              <Input
                id="cal-reschedule-url"
                value={rescheduleUrl}
                onChange={(e) => setRescheduleUrl(e.target.value)}
                placeholder="https://cal.com/your-team/30min"
              />
              <p className="text-muted-foreground text-xs">
                Sent to leads in no-show follow-up messages.
              </p>
            </div>

            <Button onClick={handleSave} disabled={saving}>
              {saving && <Loader2 className="size-4 animate-spin" />}
              Save Cal.com integration
            </Button>
          </RequireRole>

          <p className="text-muted-foreground text-xs">
            Cal.com only captures the lead&apos;s phone number if your event type has a required
            &quot;phone number&quot; booking question — add one, or bookings will be logged without
            triggering WhatsApp messages.
          </p>
        </CardContent>
      </Card>

      <Card className="opacity-60">
        <CardContent className="flex items-center justify-between p-5">
          <div className="flex items-center gap-2">
            <Calendar className="text-muted-foreground size-4" />
            <span className="text-foreground text-sm font-medium">Google Calendar</span>
          </div>
          <Badge className="border-border bg-muted text-muted-foreground text-[10px] tracking-wide uppercase">
            Coming soon
          </Badge>
        </CardContent>
      </Card>
    </section>
  );
}
