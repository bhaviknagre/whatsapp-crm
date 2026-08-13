"use client";

// ============================================================
// Inbox → contact sidebar → Meetings section.
//
// Shows the contact's recent bookings with a status badge, and a
// three-way attendance toggle (Attended / No-Show / Rescheduled) on
// each. Marking No-Show calls PATCH /api/bookings/[id]/attendance,
// which runs the no-show follow-up sequence immediately (anchored on
// "now", not the meeting's end time) — see that route for why.
// ============================================================

import { useState } from "react";
import { toast } from "sonner";
import {
  CalendarClock,
  CheckCircle2,
  Loader2,
  Plus,
  XCircle,
  RotateCcw,
  Ban,
  CalendarCog,
  Video,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { NewMeetingDialog } from "./new-meeting-dialog";
import { RescheduleMeetingDialog } from "./reschedule-meeting-dialog";

export interface BookingRow {
  id: string;
  title: string | null;
  meeting_start_at: string;
  meeting_end_at: string;
  calendar_provider: "cal_com" | "google_calendar" | "manual";
  status: "confirmed" | "rescheduled" | "cancelled";
  attendance_status: "pending" | "attended" | "no_show" | "rescheduled";
  acknowledged_at: string | null;
  meeting_link?: string | null;
}

type AttendanceStatus = BookingRow["attendance_status"];

const ATTENDANCE_OPTIONS: { value: "attended" | "no_show" | "rescheduled"; label: string; icon: typeof CheckCircle2 }[] = [
  { value: "attended", label: "Attended", icon: CheckCircle2 },
  { value: "no_show", label: "No-Show", icon: XCircle },
  { value: "rescheduled", label: "Rescheduled", icon: RotateCcw },
];

function statusBadgeClass(status: AttendanceStatus): string {
  switch (status) {
    case "attended":
      return "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400";
    case "no_show":
      return "bg-red-500/10 text-red-600 dark:text-red-400";
    case "rescheduled":
      return "bg-amber-500/10 text-amber-600 dark:text-amber-400";
    default:
      return "bg-muted text-muted-foreground";
  }
}

export function BookingPanel({
  bookings,
  contactId,
  conversationId,
  onPatched,
  onCreated,
}: {
  bookings: BookingRow[];
  contactId: string;
  conversationId: string | null;
  onPatched: (id: string, patch: Partial<BookingRow>) => void;
  onCreated: (booking: BookingRow) => void;
}) {
  const tSidebar = useTranslations("Inbox.sidebar");
  const [updating, setUpdating] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [rescheduling, setRescheduling] = useState<BookingRow | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);

  async function cancelBooking(booking: BookingRow) {
    const providerNote =
      booking.calendar_provider !== "manual"
        ? " This won't cancel it on Cal.com — cancel it there too if needed."
        : "";
    if (!window.confirm(`Cancel this meeting?${providerNote}`)) return;

    setCancelling(booking.id);
    try {
      const res = await fetch(`/api/bookings/${booking.id}/cancel`, { method: "POST" });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(payload.error || "Failed to cancel meeting.");
        return;
      }
      onPatched(booking.id, { status: "cancelled" });
      toast.success("Meeting cancelled.");
    } catch (err) {
      console.error("[BookingPanel] cancel failed:", err);
      toast.error("Network error cancelling meeting.");
    } finally {
      setCancelling(null);
    }
  }

  async function setAttendance(booking: BookingRow, next: "attended" | "no_show" | "rescheduled") {
    setUpdating(booking.id);
    try {
      const res = await fetch(`/api/bookings/${booking.id}/attendance`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attendance_status: next }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(payload.error || "Failed to update attendance.");
        return;
      }
      onPatched(booking.id, { attendance_status: next });
      if (next === "no_show") {
        toast.success("Marked as No-Show — follow-up messages are on their way.");
      }
    } catch (err) {
      console.error("[BookingPanel] attendance update failed:", err);
      toast.error("Network error updating attendance.");
    } finally {
      setUpdating(null);
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-2 px-1">
        <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          <CalendarClock className="h-3 w-3" />
          {tSidebar("meetings")}
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="h-auto p-1 text-muted-foreground hover:text-foreground"
          onClick={() => setDialogOpen(true)}
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="mt-2 space-y-2">
        {bookings.length === 0 && (
          <p className="px-1 text-xs text-muted-foreground">No meetings yet</p>
        )}
        {bookings.map((booking) => (
          <div key={booking.id} className="rounded-lg bg-muted px-3 py-2">
            <div className="flex items-start justify-between gap-2">
              <p className="text-sm font-medium text-foreground">
                {booking.title || "Meeting"}
              </p>
              <span
                className={cn(
                  "shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium capitalize",
                  statusBadgeClass(booking.attendance_status),
                )}
              >
                {booking.attendance_status.replace("_", " ")}
              </span>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {new Date(booking.meeting_start_at).toLocaleString(undefined, {
                dateStyle: "medium",
                timeStyle: "short",
              })}
            </p>
            {booking.meeting_link && booking.status !== "cancelled" && (
              <a
                href={booking.meeting_link}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1 inline-flex items-center gap-1 text-[10px] font-medium text-primary hover:underline"
              >
                <Video className="h-3 w-3" />
                Join meeting
              </a>
            )}
            {booking.status === "cancelled" ? (
              <p className="mt-1.5 text-[10px] text-muted-foreground italic">Cancelled</p>
            ) : (
              <>
                <div className="mt-2 flex gap-1">
                  {ATTENDANCE_OPTIONS.map((opt) => {
                    const Icon = opt.icon;
                    const active = booking.attendance_status === opt.value;
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        disabled={updating === booking.id}
                        onClick={() => setAttendance(booking, opt.value)}
                        title={opt.label}
                        className={cn(
                          "flex flex-1 items-center justify-center gap-1 rounded-md border px-1.5 py-1 text-[10px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                          active
                            ? "border-primary bg-primary/10 text-primary"
                            : "border-border text-muted-foreground hover:bg-background",
                        )}
                      >
                        {updating === booking.id ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <Icon className="h-3 w-3" />
                        )}
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
                <div className="mt-1 flex gap-1">
                  <button
                    type="button"
                    onClick={() => setRescheduling(booking)}
                    className="flex flex-1 items-center justify-center gap-1 rounded-md px-1.5 py-1 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-background"
                  >
                    <CalendarCog className="h-3 w-3" />
                    Reschedule
                  </button>
                  <button
                    type="button"
                    disabled={cancelling === booking.id}
                    onClick={() => cancelBooking(booking)}
                    className="flex flex-1 items-center justify-center gap-1 rounded-md px-1.5 py-1 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-background disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {cancelling === booking.id ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Ban className="h-3 w-3" />
                    )}
                    Cancel
                  </button>
                </div>
              </>
            )}
          </div>
        ))}
      </div>

      <NewMeetingDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        contactId={contactId}
        conversationId={conversationId}
        onCreated={onCreated}
      />

      {rescheduling && (
        <RescheduleMeetingDialog
          open={!!rescheduling}
          onOpenChange={(open) => !open && setRescheduling(null)}
          booking={rescheduling}
          onRescheduled={(booking) => {
            onPatched(booking.id, booking);
            setRescheduling(null);
          }}
        />
      )}
    </div>
  );
}
