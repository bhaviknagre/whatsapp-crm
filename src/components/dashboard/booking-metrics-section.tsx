import { CalendarClock, CircleCheck, UserX, RotateCcw } from 'lucide-react'
import { MetricCard } from './metric-card'
import { SkeletonCard } from './skeleton'
import type { BookingMetricsBundle } from '@/lib/dashboard/types'

function pct(value: number | null): string {
  return value === null ? '—' : `${Math.round(value)}%`
}

export function BookingMetricsSection({
  data,
  loading,
}: {
  data: BookingMetricsBundle | null
  loading: boolean
}) {
  if (loading || !data) {
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    )
  }

  return (
    <div>
      <h2 className="mb-3 text-sm font-semibold text-foreground">Bookings</h2>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          title="Total Bookings"
          value={data.totalBookings.toLocaleString()}
          icon={CalendarClock}
          subtitle="Last 30 days"
        />
        <MetricCard
          title="Confirmation Rate"
          value={pct(data.confirmationRate)}
          icon={CircleCheck}
          subtitle="Tapped “Got It”"
        />
        <MetricCard
          title="No-Show Rate"
          value={pct(data.noShowRate)}
          icon={UserX}
          subtitle="Of resolved meetings"
        />
        <MetricCard
          title="Recovered Meetings"
          value={data.recoveredMeetings.toLocaleString()}
          icon={RotateCcw}
          subtitle="No-shows that rebooked"
        />
      </div>
    </div>
  )
}
