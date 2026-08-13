"use client";

// ============================================================
// "Reschedule meeting" — move an existing booking to a new time from
// the CRM. Posts to POST /api/bookings/[id]/reschedule, which resets
// attendance to pending and re-derives reminders from the new time.
//
// One-way: for a Cal.com-sourced booking this only updates wacrm's
// own record, it does not push the change back to Cal.com.
// ============================================================

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Loader2, TriangleAlert } from "lucide-react";
import { fromZonedTime, formatInTimeZone } from "date-fns-tz";

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
import { MeetingAvailability } from "./meeting-availability";
import type { BookingRow } from "./booking-panel";

const DURATIONS = [15, 30, 45, 60, 90] as const;

const BROWSER_TIMEZONE =
  typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "UTC";

function closestDuration(minutes: number): number {
  return DURATIONS.reduce((best, d) => (Math.abs(d - minutes) < Math.abs(best - minutes) ? d : best), DURATIONS[0]);
}

export function RescheduleMeetingDialog({
  open,
  onOpenChange,
  booking,
  onRescheduled,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  booking: BookingRow;
  onRescheduled: (booking: BookingRow) => void;
}) {
  const initialStartAt = useMemo(
    () => formatInTimeZone(new Date(booking.meeting_start_at), BROWSER_TIMEZONE, "yyyy-MM-dd'T'HH:mm"),
    [booking.meeting_start_at],
  );
  const initialDuration = useMemo(
    () =>
      closestDuration(
        (new Date(booking.meeting_end_at).getTime() - new Date(booking.meeting_start_at).getTime()) / 60_000,
      ),
    [booking.meeting_start_at, booking.meeting_end_at],
  );

  const [startAt, setStartAt] = useState(initialStartAt);
  const [duration, setDuration] = useState<number>(initialDuration);
  const [saving, setSaving] = useState(false);

  const { proposedStart, proposedEnd, dateKey } = useMemo(() => {
    if (!startAt) return { proposedStart: null, proposedEnd: null, dateKey: null };
    try {
      const start = fromZonedTime(startAt, BROWSER_TIMEZONE);
      const end = new Date(start.getTime() + duration * 60 * 1000);
      return { proposedStart: start, proposedEnd: end, dateKey: startAt.slice(0, 10) };
    } catch {
      return { proposedStart: null, proposedEnd: null, dateKey: null };
    }
  }, [startAt, duration]);

  async function handleSave() {
    if (!proposedStart || !proposedEnd) {
      toast.error("That date/time isn't valid.");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/bookings/${booking.id}/reschedule`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          meeting_start_at: proposedStart.toISOString(),
          meeting_end_at: proposedEnd.toISOString(),
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(payload.error || "Failed to reschedule.");
        return;
      }
      toast.success("Meeting rescheduled.");
      onRescheduled(payload.booking as BookingRow);
    } catch (err) {
      console.error("[RescheduleMeetingDialog] save error:", err);
      toast.error("Network error rescheduling.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-border bg-popover sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">Reschedule meeting</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            Resets attendance and re-sends a confirmation for the new time.
          </DialogDescription>
        </DialogHeader>

        {booking.calendar_provider !== "manual" && (
          <div className="flex items-start gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-xs text-amber-700 dark:text-amber-300">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            This only updates wacrm — it won&apos;t move the event on Cal.com. Reschedule it there
            too, or the two will disagree.
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="reschedule-start" className="text-muted-foreground">
              Date & time
            </Label>
            <Input
              id="reschedule-start"
              type="datetime-local"
              value={startAt}
              onChange={(e) => setStartAt(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="reschedule-duration" className="text-muted-foreground">
              Duration
            </Label>
            <select
              id="reschedule-duration"
              value={duration}
              onChange={(e) => setDuration(Number(e.target.value))}
              className="h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary"
            >
              {DURATIONS.map((m) => (
                <option key={m} value={m}>
                  {m} min
                </option>
              ))}
            </select>
          </div>
        </div>

        {dateKey && (
          <MeetingAvailability
            date={dateKey}
            timezone={BROWSER_TIMEZONE}
            assigneeEmail={null}
            proposedStart={proposedStart}
            proposedEnd={proposedEnd}
            excludeBookingId={booking.id}
          />
        )}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="border-border text-muted-foreground hover:bg-muted"
          >
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving && <Loader2 className="size-4 animate-spin" />}
            Save new time
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
