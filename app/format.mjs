export const date = (x) =>
  new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(x));
export const time = (x) =>
  new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(x));
export const duration = (x) =>
  `${Math.floor(x / 60)}:${String(Math.floor(x % 60)).padStart(2, '0')}`;
export function dayLabel(value) {
  const d = new Date(value),
    today = new Date();
  if (d.toDateString() === today.toDateString()) return 'Today';
  today.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Yesterday';
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  }).format(d);
}
