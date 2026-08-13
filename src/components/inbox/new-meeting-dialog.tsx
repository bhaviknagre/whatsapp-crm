"use client";

// ============================================================
// "New Meeting" — create a booking directly from the CRM, for teams
// that don't use Cal.com or a meeting arranged over a call/email.
// Posts to POST /api/bookings, which fills lead_name/phone/email from
// the contact record and runs the exact same confirmation/reminder/
// no-show pipeline as a Cal.com-created booking.
// ============================================================

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { fromZonedTime } from "date-fns-tz";

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
import { fetchAccountMembers, memberLabel } from "@/lib/account/members";
import { useAuth } from "@/hooks/use-auth";
import type { AccountMember } from "@/types";
import type { BookingRow } from "./booking-panel";
import { MeetingAvailability } from "./meeting-availability";

const DURATIONS = [15, 30, 45, 60, 90] as const;

const BROWSER_TIMEZONE =
  typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "UTC";

function defaultDateTimeLocal(): string {
  // An hour from now, rounded to the next 15 minutes — a sane default
  // starting point rather than an empty/invalid field.
  const d = new Date(Date.now() + 60 * 60 * 1000);
  d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15, 0, 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function NewMeetingDialog({
  open,
  onOpenChange,
  contactId,
  conversationId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contactId: string;
  conversationId: string | null;
  onCreated: (booking: BookingRow) => void;
}) {
  const { user } = useAuth();
  const [title, setTitle] = useState("");
  const [startAt, setStartAt] = useState(defaultDateTimeLocal);
  const [duration, setDuration] = useState<number>(30);
  const [assignedUserId, setAssignedUserId] = useState<string>("");
  const [members, setMembers] = useState<AccountMember[]>([]);
  const [meetingLink, setMeetingLink] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    void fetchAccountMembers().then((m) => {
      setMembers(m);
      setAssignedUserId((prev) => prev || user?.id || m[0]?.user_id || "");
    });
  }, [open, user?.id]);

  const selectedAssigneeEmail = members.find((m) => m.user_id === assignedUserId)?.email ?? null;

  // Live preview of the proposed slot, recomputed on every keystroke so
  // the availability timeline below can render an overlap warning
  // before the agent submits, not after.
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

  function reset() {
    setTitle("");
    setStartAt(defaultDateTimeLocal());
    setDuration(30);
    setMeetingLink("");
  }

  async function handleCreate() {
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      toast.error("Give the meeting a title.");
      return;
    }
    if (!startAt) {
      toast.error("Pick a date and time.");
      return;
    }

    if (!proposedStart || !proposedEnd) {
      toast.error("That date/time isn't valid.");
      return;
    }
    const trimmedLink = meetingLink.trim();
    if (trimmedLink && !/^https?:\/\//i.test(trimmedLink)) {
      toast.error("Meeting link must start with http:// or https://");
      return;
    }
    const meetingStartAt = proposedStart;
    const meetingEndAt = proposedEnd;

    setSaving(true);
    try {
      const res = await fetch("/api/bookings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contact_id: contactId,
          conversation_id: conversationId,
          title: trimmedTitle,
          meeting_start_at: meetingStartAt.toISOString(),
          meeting_end_at: meetingEndAt.toISOString(),
          lead_timezone: BROWSER_TIMEZONE,
          assigned_user_id: assignedUserId || undefined,
          meeting_link: trimmedLink || undefined,
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(payload.error || "Failed to create meeting.");
        return;
      }
      toast.success("Meeting scheduled.");
      onCreated(payload.booking as BookingRow);
      reset();
      onOpenChange(false);
    } catch (err) {
      console.error("[NewMeetingDialog] create error:", err);
      toast.error("Network error creating meeting.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-border bg-popover sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">New meeting</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            Sends the same WhatsApp confirmation, reminders, and no-show follow-up as a
            Cal.com-booked meeting.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="meeting-title" className="text-muted-foreground">
              Title
            </Label>
            <Input
              id="meeting-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Discovery call"
              maxLength={200}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="meeting-start" className="text-muted-foreground">
                Date & time
              </Label>
              <Input
                id="meeting-start"
                type="datetime-local"
                value={startAt}
                onChange={(e) => setStartAt(e.target.value)}
              />
              <p className="text-muted-foreground text-xs">Your local time ({BROWSER_TIMEZONE})</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="meeting-duration" className="text-muted-foreground">
                Duration
              </Label>
              <select
                id="meeting-duration"
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

          {members.length > 0 && (
            <div className="space-y-1.5">
              <Label htmlFor="meeting-assignee" className="text-muted-foreground">
                Assigned to
              </Label>
              <select
                id="meeting-assignee"
                value={assignedUserId}
                onChange={(e) => setAssignedUserId(e.target.value)}
                className="h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary"
              >
                {members.map((m) => (
                  <option key={m.user_id} value={m.user_id}>
                    {memberLabel(m)}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="meeting-link" className="text-muted-foreground">
              Meeting link (optional)
            </Label>
            <Input
              id="meeting-link"
              value={meetingLink}
              onChange={(e) => setMeetingLink(e.target.value)}
              placeholder="https://meet.google.com/xxx-yyyy-zzz"
            />
            <p className="text-muted-foreground text-xs">
              Sent to the lead over WhatsApp right after the confirmation, so they can join
              straight from the chat.
            </p>
          </div>

          {dateKey && (
            <MeetingAvailability
              date={dateKey}
              timezone={BROWSER_TIMEZONE}
              assigneeEmail={selectedAssigneeEmail}
              proposedStart={proposedStart}
              proposedEnd={proposedEnd}
            />
          )}
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
            Schedule meeting
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
