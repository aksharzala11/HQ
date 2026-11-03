// GET /api/calendar?t=TOKEN -> your tasks and events as an iCalendar feed.
// Subscribe to it in Apple Calendar, Google Calendar or Outlook: timed items appear at
// their time with their reminder as an alarm, so your phone alerts you even when Doable
// is closed. Times are "floating" (no time zone), so they show at the same clock time
// wherever you are, like they do in Doable. The token is the only key: keep the link private.
const L = require('./_lib');

const RRULE = { daily: 'FREQ=DAILY', weekdays: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', weekly: 'FREQ=WEEKLY', monthly: 'FREQ=MONTHLY', yearly: 'FREQ=YEARLY' };
const icsText = s => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const pad = n => String(n).padStart(2, '0');
const dateOnly = ymd => ymd.replace(/-/g, '');
function addMinutes(ymd, hm, mins) {
  const [y, m, d] = ymd.split('-').map(Number), [h, mi] = hm.split(':').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d, h, mi + mins));
  return `${t.getUTCFullYear()}${pad(t.getUTCMonth() + 1)}${pad(t.getUTCDate())}T${pad(t.getUTCHours())}${pad(t.getUTCMinutes())}00`;
}
function nextDay(ymd) { const [y, m, d] = ymd.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1, d + 1)); return `${t.getUTCFullYear()}${pad(t.getUTCMonth() + 1)}${pad(t.getUTCDate())}`; }
const stamp = ms => new Date(ms || Date.now()).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
// lines longer than 75 octets are folded (RFC 5545 3.1)
function fold(line) {
  const out = []; let cur = '', bytes = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch);
    if (bytes + b > (out.length ? 74 : 75)) { out.push(cur); cur = ''; bytes = 0; }
    cur += ch; bytes += b;
  }
  out.push(cur);
  return out.join('\r\n ');
}

module.exports = L.handler(async (req, res) => {
  const token = new URL(req.url, 'http://x').searchParams.get('t');
  if (!token || token.length < 20) throw new L.HttpError(404, 'Not found');
  const [user] = await L.db(`select id from users where cal = $1`, [token]);
  if (!user) throw new L.HttpError(404, 'Not found');
  const [row] = await L.db(`select data from state where user_id = $1`, [user.id]);
  const items = ((row && row.data && row.data.tasks) || []).filter(t => !t.deleted && t.due && t.status === 'open');

  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//HQ//HQ//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'X-WR-CALNAME:HQ', 'REFRESH-INTERVAL;VALUE=DURATION:PT15M', 'X-PUBLISHED-TTL:PT15M'];
  for (const t of items) {
    const ev = t.kind === 'event';
    lines.push('BEGIN:VEVENT', `UID:${t.id}@hq`, `DTSTAMP:${stamp(t.updatedAt || t.createdAt)}`, `SUMMARY:${icsText((ev ? '' : '☐ ') + t.title)}`);
    if (t.time) {
      const len = t.duration || (ev ? 60 : 30);
      lines.push(`DTSTART:${addMinutes(t.due, t.time, 0)}`, `DTEND:${addMinutes(t.due, t.time, len)}`);
    } else {
      lines.push(`DTSTART;VALUE=DATE:${dateOnly(t.due)}`, `DTEND;VALUE=DATE:${nextDay(t.due)}`, 'TRANSP:TRANSPARENT');
    }
    if (t.notes) lines.push(`DESCRIPTION:${icsText(t.notes)}`);
    if (RRULE[t.repeat]) lines.push(`RRULE:${RRULE[t.repeat]}`);
    if (t.reminder !== '' && t.reminder != null) {
      // all-day items remind at 9:00 on the day, like the app does
      const before = Number(t.reminder) - (t.time ? 0 : 9 * 60);
      lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsText(t.title)}`, `TRIGGER:${before > 0 ? '-' : ''}PT${Math.abs(before)}M`, 'END:VALARM');
    }
    lines.push('END:VEVENT');
  }
  // classes from the School timetable: one weekly series per meeting time
  const BYDAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
  for (const c of ((row && row.data && row.data.courses) || []).filter(c => !c.archived)) {
    (c.meetings || []).forEach((m, i) => {
      if (!m.days || !m.days.length || !m.start || !m.end || m.end <= m.start) return;
      // first meeting on/after the day the class was added (or its start date)
      const from = c.starts || new Date(c.createdAt || Date.now()).toISOString().slice(0, 10);
      let [y, mo, d] = from.split('-').map(Number), first;
      for (let k = 0; k < 7; k++) { const t = new Date(Date.UTC(y, mo - 1, d + k)); if (m.days.includes(t.getUTCDay())) { first = t.toISOString().slice(0, 10); break; } }
      if (!first) return;
      const len = (+m.end.slice(0, 2) * 60 + +m.end.slice(3, 5)) - (+m.start.slice(0, 2) * 60 + +m.start.slice(3, 5));
      lines.push('BEGIN:VEVENT', `UID:class-${c.id}-${i}@hq`, `DTSTAMP:${stamp(c.updatedAt || c.createdAt)}`, `SUMMARY:${icsText(c.name)}`,
        `DTSTART:${addMinutes(first, m.start, 0)}`, `DTEND:${addMinutes(first, m.start, len)}`,
        `RRULE:FREQ=WEEKLY;BYDAY=${m.days.map(x => BYDAY[x]).join(',')}${c.ends ? `;UNTIL=${c.ends.replace(/-/g, '')}T235959` : ''}`);
      if (m.room || c.room) lines.push(`LOCATION:${icsText(m.room || c.room)}`);
      if (c.teacher) lines.push(`DESCRIPTION:${icsText(c.teacher)}`);
      lines.push('END:VEVENT');
    });
  }
  lines.push('END:VCALENDAR');
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', 'inline; filename="hq.ics"');
  res.setHeader('Cache-Control', 'no-store');
  res.end(lines.map(fold).join('\r\n') + '\r\n');
});
