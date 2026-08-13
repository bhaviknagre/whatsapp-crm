"use client";

// ============================================================
// "Who's free when" — a lightweight day timeline (no calendar library
// needed) showing every teammate's existing confirmed bookings for
// the selected date, with the currently-proposed slot overlaid so an
// agent can see a conflict before saving instead of after.
//
// Fixed 7:00–21:00 local window — covers the overwhelming majority of
// business meetings; a booking outside that range still counts toward
// the conflict check, it just won't have a visible block.
// ============================================================

import { useEffect, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

const WINDOW_START_HOUR = 7;
const WINDOW_END_HOUR = 21;
const WINDOW_MINUTES = (WINDOW_END_HOUR - WINDOW_START_HOUR) * 60;

interface AvailabilityBooking {
  id: string;
  title: string | null;
  meeting_start_at: string;
  meeting_end_at: string;
  assigned_profile_id: string | null;
  assignee: { id: string; full_name: string | null; email: string | null } | null;
}

function minutesFromWindowStart(iso: string): number {
  const d = new Date(iso);
  return (d.getHours() - WINDOW_START_HOUR) * 60 + d.getMinutes();
}

function blockStyle(startIso: string, endIso: string): React.CSSProperties {
  const start = Math.max(0, minutesFromWindowStart(startIso));
  const end = Math.min(WINDOW_MINUTES, minutesFromWindowStart(endIso));
  const left = (start / WINDOW_MINUTES) * 100;
  const width = Math.max(1, ((end - start) / WINDOW_MINUTES) * 100);
  return { left: `${left}%`, width: `${width}%` };
}

function overlaps(aStart: Date, aEnd: Date, bStartIso: string, bEndIso: string): boolean {
  const bStart = new Date(bStartIso);
  const bEnd = new Date(bEndIso);
  return aStart < bEnd && aEnd > bStart;
}

export function MeetingAvailability({
  date,
  timezone,
  assigneeEmail,
  proposedStart,
  proposedEnd,
  excludeBookingId,
}: {
  /** YYYY-MM-DD, in `timezone`. */
  date: string;
  timezone: string;
  /** Highlights this teammate's row and drives the conflict warning. */
  assigneeEmail: string | null;
  proposedStart: Date | null;
  proposedEnd: Date | null;
  /** Omit this booking from its own conflict check when rescheduling it. */
  excludeBookingId?: string;
}) {
  const [bookings, setBookings] = useState<AvailabilityBooking[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    const params = new URLSearchParams({ date, timezone });
    fetch(`/api/bookings/availability?${params.toString()}`, { cache: "no-store" })
      .then((res) => res.json())
      .then((data: { bookings?: AvailabilityBooking[] }) => {
        if (!cancelled) setBookings(data.bookings ?? []);
      })
      .catch((err) => console.error("[MeetingAvailability] fetch failed:", err))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [date, timezone]);

  const relevant = excludeBookingId ? bookings.filter((b) => b.id !== excludeBookingId) : bookings;

  const byAssignee = new Map<string, { label: string; email: string | null; bookings: AvailabilityBooking[] }>();
  for (const b of relevant) {
    const key = b.assignee?.id ?? "unassigned";
    const label = b.assignee?.full_name || b.assignee?.email || "Unassigned";
    if (!byAssignee.has(key)) {
      byAssignee.set(key, { label, email: b.assignee?.email ?? null, bookings: [] });
    }
    byAssignee.get(key)!.bookings.push(b);
  }

  const hasConflict =
    proposedStart &&
    proposedEnd &&
    assigneeEmail &&
    relevant.some(
      (b) =>
        b.assignee?.email?.toLowerCase() === assigneeEmail.toLowerCase() &&
        overlaps(proposedStart, proposedEnd, b.meeting_start_at, b.meeting_end_at),
    );

  const hourMarks = Array.from(
    { length: WINDOW_END_HOUR - WINDOW_START_HOUR + 1 },
    (_, i) => WINDOW_START_HOUR + i,
  );

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-muted-foreground text-xs font-medium">Team availability that day</p>
        {loading && <Loader2 className="text-muted-foreground h-3 w-3 animate-spin" />}
      </div>

      {hasConflict && (
        <div className="flex items-center gap-1.5 rounded-md border border-red-500/30 bg-red-500/10 px-2 py-1.5 text-xs text-red-600 dark:text-red-400">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          This overlaps an existing meeting for the assigned teammate.
        </div>
      )}

      {!loading && byAssignee.size === 0 && (
        <p className="text-muted-foreground text-xs">No other bookings that day.</p>
      )}

      {byAssignee.size > 0 && (
        <div className="space-y-1.5">
          {/* Hour ticks */}
          <div className="relative h-3 text-[9px] text-muted-foreground">
            {hourMarks.map((h) => (
              <span
                key={h}
                className="absolute -translate-x-1/2"
                style={{ left: `${((h - WINDOW_START_HOUR) / (WINDOW_END_HOUR - WINDOW_START_HOUR)) * 100}%` }}
              >
                {h}
              </span>
            ))}
          </div>

          {Array.from(byAssignee.entries()).map(([key, group]) => {
            const isSelectedAssignee = assigneeEmail && group.email?.toLowerCase() === assigneeEmail.toLowerCase();
            return (
              <div key={key} className="flex items-center gap-2">
                <span
                  className={cn(
                    "w-20 shrink-0 truncate text-[10px]",
                    isSelectedAssignee ? "font-semibold text-foreground" : "text-muted-foreground",
                  )}
                  title={group.label}
                >
                  {group.label}
                </span>
                <div className="relative h-4 flex-1 rounded bg-muted">
                  {group.bookings.map((b) => (
                    <div
                      key={b.id}
                      className="absolute top-0 h-4 rounded bg-amber-500/60"
                      style={blockStyle(b.meeting_start_at, b.meeting_end_at)}
                      title={`${b.title || "Meeting"} · ${new Date(b.meeting_start_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`}
                    />
                  ))}
                  {isSelectedAssignee && proposedStart && proposedEnd && (
                    <div
                      className={cn(
                        "absolute top-0 h-4 rounded border-2",
                        hasConflict
                          ? "border-red-500 bg-red-500/30"
                          : "border-primary bg-primary/30",
                      )}
                      style={blockStyle(proposedStart.toISOString(), proposedEnd.toISOString())}
                    />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
