/** Formatting shared by server and client components. No environment access, no data fetching. */

const UNITS: [limit: number, seconds: number, name: Intl.RelativeTimeFormatUnit][] = [
  [60, 1, 'second'],
  [3600, 60, 'minute'],
  [86_400, 3600, 'hour'],
  [2_592_000, 86_400, 'day'],
];

const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/** "12 minutes ago" / "in 43 minutes". Past and future, one function, because expiry needs both. */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const delta = (new Date(iso).getTime() - now.getTime()) / 1000;

  if (!Number.isFinite(delta)) {
    return '—';
  }

  for (const [limit, seconds, unit] of UNITS) {
    if (Math.abs(delta) < limit) {
      return relative.format(Math.round(delta / seconds), unit);
    }
  }

  return relative.format(Math.round(delta / 2_592_000), 'month');
}

const timestamp = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium',
  timeStyle: 'medium',
  timeZone: 'UTC',
});

/** UTC, always, and labelled as such: the gateway counts its days in UTC (see `stats.routes`). */
export function absoluteTime(iso: string): string {
  const date = new Date(iso);

  return Number.isNaN(date.getTime()) ? iso : `${timestamp.format(date)} UTC`;
}

/** Clock-style time only, for a dense audit column where the date is already implied. */
export function clockTime(iso: string): string {
  const date = new Date(iso);

  return Number.isNaN(date.getTime()) ? iso : date.toISOString().slice(11, 19).concat(' UTC');
}

export function bytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} kB`;
  }

  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export function count(value: number): string {
  return new Intl.NumberFormat('en').format(value);
}

/** "43 min left" / "expired". The mission page's countdown, rendered from a fixed instant. */
export function timeLeft(iso: string, now: Date = new Date()): string {
  const delta = new Date(iso).getTime() - now.getTime();

  if (!Number.isFinite(delta)) {
    return '—';
  }
  if (delta <= 0) {
    return 'expired';
  }

  const minutes = Math.floor(delta / 60_000);
  if (minutes < 60) {
    return `${minutes} min left`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    return `${hours} h ${minutes % 60} min left`;
  }

  return `${Math.floor(hours / 24)} days left`;
}
