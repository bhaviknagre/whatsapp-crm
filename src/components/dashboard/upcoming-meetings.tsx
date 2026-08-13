import { CalendarClock } from 'lucide-react'
import type { UpcomingBooking } from '@/lib/dashboard/types'
import { EmptyState } from './empty-state'
import { Skeleton } from './skeleton'

function formatWhen(iso: string): { day: string; time: string } {
  const d = new Date(iso)
  const today = new Date()
  const isToday = d.toDateString() === today.toDateString()
  const tomorrow = new Date(today)
  tomorrow.setDate(tomorrow.getDate() + 1)
  const isTomorrow = d.toDateString() === tomorrow.toDateString()

  const day = isToday
    ? 'Today'
    : isTomorrow
      ? 'Tomorrow'
      : d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  return { day, time }
}

export function UpcomingMeetings({
  bookings,
  loading,
}: {
  bookings: UpcomingBooking[] | null
  loading: boolean
}) {
  if (loading) {
    return (
      <div className="rounded-xl border border-border bg-card p-5">
        <Skeleton className="h-4 w-40" />
        <div className="mt-4 space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      </div>
    )
  }

  const items = bookings ?? []

  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground">Upcoming meetings</h2>
        <span className="text-xs text-muted-foreground">{items.length}</span>
      </div>

      {items.length === 0 ? (
        <EmptyState
          icon={CalendarClock}
          title="No upcoming meetings"
          hint="Meetings booked via Cal.com or scheduled from a conversation will show up here."
          className="mt-3"
        />
      ) : (
        <ul className="mt-3 divide-y divide-border">
          {items.map((b) => {
            const { day, time } = formatWhen(b.meeting_start_at)
            return (
              <li key={b.id} className="flex items-center gap-3 py-2.5">
                <div className="flex h-9 w-14 shrink-0 flex-col items-center justify-center rounded-lg bg-muted text-center">
                  <span className="text-[10px] leading-none text-muted-foreground">{day}</span>
                  <span className="text-xs leading-none font-semibold text-foreground">{time}</span>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">
                    {b.title || 'Meeting'}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {b.lead_name || 'Unknown lead'}
                    {b.assignee_name ? ` · ${b.assignee_name}` : ''}
                  </p>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
