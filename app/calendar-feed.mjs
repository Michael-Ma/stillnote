// Calendars read from a private iCal link (Google's "Secret address in iCal format", Outlook's
// published ICS link, an iCloud public calendar), so meetings do not depend on the Mac's Calendar
// app. A link is as good as a password to that calendar: it stays encrypted on this Mac, is never
// in a backup, and the interface only ever sees its host.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import ICAL from 'ical.js';

const MAX_BYTES = 5_000_000;
const MAX_FEEDS = 10;
// A daily meeting going back fifteen years, and then some.
const MAX_OCCURRENCES = 20_000;

// The https address of a calendar link; webcal:// is the same address for calendar apps.
export function feedUrl(input) {
  let url;
  try {
    url = new URL(
      String(input ?? '')
        .trim()
        .replace(/^webcals?:\/\//i, 'https://'),
    );
  } catch {
    throw new Error('Paste the full calendar link.');
  }
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname.includes('.'))
    throw new Error('Paste the full calendar link.');
  return url.href;
}

// A calendar link in copied text, or null. Nothing else on the clipboard is ever looked at or kept.
const LINKS = [
  ['google', /https:\/\/calendar\.google\.com\/calendar\/ical\/[^\s"'<>]+\/basic\.ics/i],
  ['outlook', /https:\/\/outlook\.(?:office365|office|live)\.com\/owa\/calendar\/[^\s"'<>]+\.ics/i],
  ['icloud', /webcals?:\/\/[\w-]+\.icloud\.com\/published\/[^\s"'<>]+/i],
];
export function recognizeFeed(text) {
  for (const [kind, re] of LINKS) {
    const found = re.exec(String(text ?? '').slice(0, 10_000))?.[0];
    if (found) return { kind, url: feedUrl(found), host: new URL(feedUrl(found)).host };
  }
  return null;
}

// An instant from a calendar time. Most feeds define their zones; for one that only names it, the
// IANA name is resolved here, and a time with no zone at all is local.
function instant(time, tzid) {
  if (time.zone === ICAL.Timezone.utcTimezone || !tzid || time.zone?.tzid === tzid)
    return time.toJSDate();
  const wall = Date.UTC(time.year, time.month - 1, time.day, time.hour, time.minute, time.second);
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', {
        timeZone: tzid,
        hourCycle: 'h23',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
      })
        .formatToParts(new Date(wall))
        .map((part) => [part.type, Number(part.value)]),
    );
    const shown = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    );
    return new Date(wall - (shown - wall));
  } catch {
    return time.toJSDate();
  }
}
const iso = (date) => date.toISOString().replace(/\.000Z$/, 'Z');
const text = (component, name) => {
  const value = component.getFirstPropertyValue(name);
  return typeof value === 'string' ? value : '';
};
function people(component) {
  return component
    .getAllProperties('attendee')
    .map(
      (attendee) =>
        attendee.getParameter('cn') ||
        String(attendee.getFirstValue() ?? '').replace(/^mailto:/i, ''),
    )
    .filter(Boolean)
    .join(', ');
}

// One occurrence in the shape the Mac's calendar gives (native/Capture.swift).
function occurrence(feed, component, startTime, endTime) {
  const zone = (name) => component.getFirstProperty(name)?.getParameter('tzid');
  const start = startTime.isDate ? startTime.toJSDate() : instant(startTime, zone('dtstart'));
  const end = endTime?.isDate ? endTime.toJSDate() : endTime && instant(endTime, zone('dtend'));
  return {
    id: `ics:${feed}:${text(component, 'uid')}`,
    title: text(component, 'summary') || 'Meeting',
    start: iso(start),
    end: iso(end ?? start),
    participants: people(component),
    location: text(component, 'location'),
    notes: text(component, 'description'),
    // Google and Microsoft name the call in their own fields.
    url:
      text(component, 'url') ||
      text(component, 'x-google-conference') ||
      text(component, 'x-microsoft-skypeteamsmeetingurl'),
    allDay: !!startTime.isDate,
    color: '',
  };
}

// The occurrences of an iCal document between two dates, soonest first.
export function parseFeed(document, { feed = 'feed', from, to }) {
  let root;
  try {
    root = new ICAL.Component(ICAL.parse(String(document)));
  } catch {
    throw new Error('This link did not return a calendar.');
  }
  if (root.name !== 'vcalendar') throw new Error('This link did not return a calendar.');
  for (const zone of root.getAllSubcomponents('vtimezone')) {
    try {
      ICAL.TimezoneService.register(zone);
    } catch {}
  }
  const masters = new Map(),
    exceptions = [];
  for (const component of root.getAllSubcomponents('vevent')) {
    const event = new ICAL.Event(component);
    if (event.isRecurrenceException()) exceptions.push(event);
    else if (event.uid) masters.set(event.uid, event);
  }
  const lone = [];
  for (const exception of exceptions) {
    if (masters.has(exception.uid)) masters.get(exception.uid).relateException(exception);
    else lone.push(exception);
  }
  const found = [];
  const add = (component, start, end) => {
    if (text(component, 'status').toUpperCase() === 'CANCELLED') return;
    const item = occurrence(feed, component, start, end);
    if (Date.parse(item.end) > from.getTime() && Date.parse(item.start) < to.getTime())
      found.push(item);
  };
  for (const event of lone) add(event.component, event.startDate, event.endDate);
  for (const event of masters.values()) {
    if (!event.isRecurring()) {
      add(event.component, event.startDate, event.endDate);
      continue;
    }
    const iterator = event.iterator();
    for (let i = 0, next; i < MAX_OCCURRENCES && (next = iterator.next()); i++) {
      const details = event.getOccurrenceDetails(next);
      if (details.startDate.toJSDate() >= to) break;
      add(details.item.component, details.startDate, details.endDate);
    }
  }
  return found.sort((a, b) => a.start.localeCompare(b.start));
}

// The Mac's events and the links' together; a meeting in both stays as the Mac's, whose id its
// note may already carry.
export function mergeCalendars(mac, feeds) {
  const key = (event) => `${event.title}|${Date.parse(event.start)}|${Date.parse(event.end)}`;
  const seen = new Set(mac.map(key));
  return [...mac, ...feeds.filter((event) => !seen.has(key(event)))].sort(
    (a, b) => Date.parse(a.start) - Date.parse(b.start),
  );
}

export class CalendarFeeds {
  constructor({ path, encryption, fetch = globalThis.fetch, now = () => new Date() }) {
    Object.assign(this, { path, encryption, fetch, now });
    this.feeds = [];
    this.problems = {};
  }
  load() {
    if (!existsSync(this.path)) return;
    if (!this.encryption.isEncryptionAvailable())
      throw new Error('macOS credential encryption is unavailable.');
    this.feeds = JSON.parse(this.encryption.decryptString(readFileSync(this.path)));
  }
  save() {
    if (!this.encryption.isEncryptionAvailable())
      throw new Error('macOS credential encryption is unavailable.');
    writeFileSync(this.path + '.tmp', this.encryption.encryptString(JSON.stringify(this.feeds)), {
      mode: 0o600,
    });
    renameSync(this.path + '.tmp', this.path);
  }
  // What the interface may see: never the link itself.
  list() {
    return this.feeds.map(({ id, url }) => ({
      id,
      host: new URL(url).host,
      problem: this.problems[id] ?? null,
    }));
  }
  async read(url) {
    const response = await this.fetch(url, {
      headers: { Accept: 'text/calendar, */*' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok)
      throw new Error(`The calendar link stopped working (${response.status}). Add it again.`);
    const body = await response.text();
    if (body.length > MAX_BYTES) throw new Error('This calendar is too large.');
    return body;
  }
  window() {
    const from = this.now();
    from.setHours(0, 0, 0, 0);
    return { from, to: new Date(from.getTime() + 7 * 86_400_000) };
  }
  // Checked by reading it, so a wrong link is refused here and not silently empty later.
  async add(input) {
    const url = feedUrl(input);
    if (this.feeds.length >= MAX_FEEDS) throw new Error('Remove a calendar link first.');
    const id = createHash('sha256').update(url).digest('hex').slice(0, 12);
    if (this.feeds.some((feed) => feed.id === id))
      throw new Error('This calendar is already added.');
    parseFeed(await this.read(url), { feed: id, ...this.window() });
    this.feeds.push({ id, url });
    this.save();
    return this.list();
  }
  remove(id) {
    this.feeds = this.feeds.filter((feed) => feed.id !== id);
    delete this.problems[id];
    this.save();
    return this.list();
  }
  // Every link's events. A link that fails keeps its last good events until the app restarts, so
  // a passing outage does not silence reminders; its problem shows in Settings.
  async events() {
    this.cache ??= {};
    await Promise.all(
      this.feeds.map(async ({ id, url }) => {
        try {
          this.cache[id] = parseFeed(await this.read(url), { feed: id, ...this.window() });
          delete this.problems[id];
        } catch (error) {
          this.problems[id] = error.message;
        }
      }),
    );
    return this.feeds.flatMap(({ id }) => this.cache[id] ?? []);
  }
}
