// The arithmetic of the todo accuracy measurement: splitting meetings, pooling what each run found into tasks
// a person labels once, and scoring a run against those labels. Pure and free of meeting content;
// scripts/todo-accuracy.mjs does the reading and the talking. Tests use invented data only.
import { likeness, sameTask } from '../app/todos.mjs';

const random = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

export function shuffled(list, seed) {
  const next = random(seed);
  const result = [...list];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// One meeting's share to tune on, the same way in every stratum, so the rest stays a fair test.
export function splitMeetings(meetings, seed, tuningSize) {
  const strata = Map.groupBy(shuffled(meetings, seed), (m) => m.stratum);
  const ordered = [...strata.values()].sort((a, b) => b.length - a.length);
  const dev = [];
  for (let i = 0; dev.length < tuningSize && i < meetings.length; i++) {
    const stratum = ordered[i % ordered.length];
    if (stratum.length) dev.push(stratum.pop());
  }
  const chosen = new Set(dev.map((m) => m.id));
  return {
    dev: dev.map((m) => m.id),
    test: meetings.filter((m) => !chosen.has(m.id)).map((m) => m.id),
  };
}

const headings =
  /^\s{0,3}#{1,6}\s*(next\s*steps?|action\s*items?|follow[- ]?ups?|to-?dos?|下一步|后续|行动项|待办|待跟进|跟进)/i;

// What the notes already say, with no model involved: the bullets of the next-steps section.
export function nextStepItems(summary = '') {
  const lines = summary.split('\n');
  const start = lines.findIndex((line) => headings.test(line));
  if (start < 0) return [];
  const items = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\s{0,3}#{1,6}\s/.test(line)) break;
    const bullet = line.match(/^[-*•]\s+(.*)$/);
    if (!bullet) continue;
    const owner = bullet[1].match(/^\*\*(.+?)\*\*\s*[:：]?\s*(.*)$/);
    const name = owner?.[1].replace(/[:：]$/, '').trim();
    items.push({
      text: (owner ? owner[2] : bullet[1]).trim(),
      assignee: !owner ? 'unclear' : /^(me|i|我)$/i.test(name) ? 'me' : 'other',
      owner: name ?? null,
      evidence: null,
    });
  }
  return items;
}

export const memberKey = (run, meetingId, index) => `${run}/${meetingId}/${index}`;

// Every run's items as tasks: a task already in the pool stays, with its labels, and gains this
// item as another way of saying it.
export function poolItems(candidates, run, meetingId, items) {
  const pool = [...candidates];
  items.forEach((item, index) => {
    const key = memberKey(run, meetingId, index);
    if (pool.some((c) => c.members.includes(key))) return;
    let best = null,
      bestScore = sameTask;
    for (const candidate of pool) {
      if (candidate.meetingId !== meetingId) continue;
      const score = likeness(candidate, item);
      if (score >= bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
    if (best) {
      best.members.push(key);
      best.evidence ??= item.evidence ?? null;
    } else
      pool.push({
        id: `c${pool.length + 1}`,
        meetingId,
        text: item.text,
        evidence: item.evidence ?? null,
        members: [key],
      });
  });
  return pool;
}

const strongest = ['me', 'unclear', 'other'];

// One row per task a person judged in these meetings: what it really is, and what this run said.
export function taskRows({ candidates, labels, run, items, meetingIds, missing = {} }) {
  const meetings = new Set(meetingIds);
  const said = new Map(
    items.map(({ meetingId, index, assignee }) => [memberKey(run, meetingId, index), assignee]),
  );
  const canonical = (id) => {
    const seen = new Set();
    while (labels[id]?.dupOf && !seen.has(id)) {
      seen.add(id);
      id = labels[id].dupOf;
    }
    return id;
  };
  const tasks = new Map();
  let unlabeled = 0;
  for (const candidate of candidates) {
    if (!meetings.has(candidate.meetingId)) continue;
    const id = canonical(candidate.id);
    if (!labels[id]?.label) {
      if (candidate.members.some((key) => said.has(key))) unlabeled++;
      continue;
    }
    if (!tasks.has(id))
      tasks.set(id, { id, meetingId: candidate.meetingId, gold: labels[id].label, says: [] });
    for (const key of candidate.members) if (said.has(key)) tasks.get(id).says.push(said.get(key));
  }
  const rows = [...tasks.values()].map(({ says, ...task }) => ({
    ...task,
    pred: strongest.find((a) => says.includes(a)) ?? null,
    repeats: Math.max(0, says.length - 1),
  }));
  for (const [meetingId, lines] of Object.entries(missing))
    if (meetings.has(meetingId))
      for (const [i, _] of lines.entries())
        rows.push({
          id: `missing-${meetingId}-${i}`,
          meetingId,
          gold: 'mine',
          pred: null,
          repeats: 0,
        });
  return { rows, unlabeled };
}

const ratio = (a, b) => (b ? a / b : null);

export function metrics(rows) {
  const count = (test) => rows.filter(test).length;
  const mine = (r) => r.gold === 'mine',
    judged = (r) => r.gold !== 'unsure',
    me = (r) => r.pred === 'me',
    unclear = (r) => r.pred === 'unclear',
    listed = (r) => me(r) || unclear(r),
    both = (a, b) => (r) => a(r) && b(r),
    theirs = (r) => r.gold === 'other',
    notTask = (r) => r.gold === 'not_task',
    saidOther = (r) => r.pred === 'other';
  const repeats = rows.reduce((sum, r) => sum + (listed(r) ? r.repeats : 0), 0);
  return {
    tasks: rows.length,
    mine: count(mine),
    listed: count(listed),
    precisionMine: ratio(count(both(me, mine)), count(both(me, judged))),
    precisionList: ratio(count(both(listed, mine)), count(both(listed, judged))),
    recallStrict: ratio(count(both(mine, me)), count(mine)),
    recallList: ratio(count(both(mine, listed)), count(mine)),
    unclearShare: ratio(count(unclear), count(listed)),
    unclearIsMine: ratio(count(both(unclear, mine)), count(both(unclear, judged))),
    flipRate: ratio(
      count(both(me, theirs)) + count(both(saidOther, mine)),
      count((r) => (me(r) || saidOther(r)) && (mine(r) || theirs(r))),
    ),
    repeatRate: ratio(repeats, count(listed) + repeats),
    errors: {
      otherListedAsMine: count(both(me, theirs)),
      otherListedAsUnclear: count(both(unclear, theirs)),
      notTaskAsMine: count(both(me, notTask)),
      notTaskAsUnclear: count(both(unclear, notTask)),
      mineSaidOther: count(both(saidOther, mine)),
      mineMissed: count((r) => mine(r) && r.pred === null),
    },
  };
}

// Tasks in one meeting are not independent, so whole meetings are resampled.
export function bootstrap(rows, stat, { seed = 1, rounds = 2000 } = {}) {
  const byMeeting = [...Map.groupBy(rows, (r) => r.meetingId).values()];
  if (!byMeeting.length) return null;
  const next = random(seed);
  const values = [];
  for (let round = 0; round < rounds; round++) {
    const sample = byMeeting.flatMap(() => byMeeting[Math.floor(next() * byMeeting.length)]);
    const value = stat(sample);
    if (value !== null) values.push(value);
  }
  if (!values.length) return null;
  values.sort((a, b) => a - b);
  return [values[Math.floor(values.length * 0.025)], values[Math.floor(values.length * 0.975)]];
}

// The score of a proportion alone, without regard to meetings: the narrower, optimistic interval.
export function wilson(hits, total, z = 1.96) {
  if (!total) return null;
  const p = hits / total,
    denominator = 1 + (z * z) / total,
    centre = p + (z * z) / (2 * total),
    margin = z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
  return [(centre - margin) / denominator, (centre + margin) / denominator];
}
