// Opt-in measurement of how well Stillnote tells my todos from other people's, on my own meetings.
// Never run in CI. The notebook is only ever opened read-only. Meeting content stays in the
// evaluation folder, outside the repo, and this script prints counts, never content:
//   node scripts/todo-accuracy.mjs split --names "Name, Other name"   decide tuning and test meetings
//   node scripts/todo-accuracy.mjs baseline                           read existing next steps (no AI)
//   node scripts/todo-accuracy.mjs extract --run v1 --set dev         ask the model; resumes if stopped
//   node scripts/todo-accuracy.mjs extract --run wide --set dev --wide    a deliberately greedy pass
//   node scripts/todo-accuracy.mjs pool --runs baseline,v1,wide --set dev  tasks to label
//   node scripts/todo-accuracy.mjs label --set dev                    label them on a local page
//     --only v3,v4 shows just what those runs found and nobody has labelled yet
//   node scripts/todo-accuracy.mjs score --run v1 --set dev --errors  numbers; errors only for dev
//   node scripts/todo-accuracy.mjs chatgpt                            read what the app itself found
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ClaudeCode } from '../app/providers/claude-code.mjs';
import {
  parseTodoResponse,
  proposedTodos,
  scannable,
  todoInstructions,
  todoRequest,
} from '../app/todos.mjs';
import {
  bootstrap,
  metrics,
  nextStepItems,
  poolItems,
  shuffled,
  splitMeetings,
  taskRows,
  wilson,
} from './todo-score.mjs';

const args = process.argv.slice(3);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at < 0 ? fallback : args[at + 1];
};
const flag = (name) => args.includes(name);
const support = join(homedir(), 'Library/Application Support');
const notebook = option('--notebook', join(support, 'Stillnote/notebook.sqlite'));
const dir = option('--dir', join(support, 'Stillnote-accuracy'));
const path = (...parts) => join(dir, ...parts);
const read = (file, fallback) =>
  existsSync(path(file)) ? JSON.parse(readFileSync(path(file), 'utf8')) : fallback;
const write = (file, value) => {
  writeFileSync(path(file), JSON.stringify(value, null, 2), { mode: 0o600 });
  chmodSync(path(file), 0o600);
};
mkdirSync(path('runs'), { recursive: true, mode: 0o700 });
chmodSync(dir, 0o700);

function readNotebook() {
  const db = new DatabaseSync(notebook, { readOnly: true });
  try {
    const rows = db.prepare('SELECT id, data FROM meetings ORDER BY id').all();
    const fingerprint = createHash('sha256');
    for (const row of rows) fingerprint.update(row.id).update(row.data);
    let todos = [];
    try {
      todos = db.prepare('SELECT data FROM todos').all();
    } catch {
      // A notebook from before todos.
    }
    return {
      meetings: rows.map((row) => ({ recordings: [], ...JSON.parse(row.data) })),
      todos: todos.map((row) => JSON.parse(row.data)),
      fingerprint: fingerprint.digest('hex'),
    };
  } finally {
    db.close();
  }
}

const describe = (m) => {
  const others = (m.participants || '').split(/[,，;、\n]/).filter((x) => x.trim()).length;
  const mic = m.transcript.some((s) => s.source === 'microphone'),
    system = m.transcript.some((s) => s.source === 'system');
  const language = /[一-鿿]/.test(
    (m.summary || m.notes || '').slice(0, 400) +
      m.transcript
        .slice(0, 20)
        .map((s) => s.text)
        .join(''),
  )
    ? 'zh'
    : 'en';
  return {
    id: m.id,
    sides: mic && system ? 'two' : mic || system ? 'one' : 'none',
    language,
    size: others <= 2 ? 'pair' : 'group',
    stratum: `${mic && system ? 'two' : 'other'}/${language}`,
  };
};

function chosen(split) {
  const set = option('--set', 'dev');
  if (set === 'dev') return split.dev;
  if (set === 'test') return split.test;
  if (set === 'all') return [...split.dev, ...split.test];
  throw new Error('--set is dev, test or all.');
}
const needSplit = () => {
  const split = read('split.json');
  if (!split) throw new Error('Run split first.');
  return split;
};

const commands = {
  // Fixed once: running it again keeps the first decision, so the test set stays unseen.
  split() {
    if (read('split.json')) return console.log('Already split; keeping it.');
    const names = option('--names', '');
    if (!names.trim()) throw new Error('--names is required.');
    const { meetings, fingerprint } = readNotebook();
    const live = meetings.filter(scannable).map(describe);
    const recorded = live.filter((m) => m.sides !== 'none');
    const seed = Number(option('--seed', 20261031));
    const { dev, test } = splitMeetings(recorded, seed, Number(option('--dev', 4)));
    const notesOnly = live.filter((m) => m.sides === 'none').map((m) => m.id);
    const audit = shuffled(test, seed).slice(0, 3);
    write('split.json', {
      names,
      seed,
      dev,
      test: [...test, ...notesOnly],
      audit,
      meetings: Object.fromEntries(live.map((m) => [m.id, m])),
    });
    write('fingerprint.json', { before: fingerprint });
    console.log({ dev: dev.length, test: test.length + notesOnly.length, audit: audit.length });
    const tally = {};
    for (const m of live)
      tally[`${m.sides}/${m.language}/${m.size}`] =
        (tally[`${m.sides}/${m.language}/${m.size}`] ?? 0) + 1;
    console.log(tally);
  },

  baseline() {
    const { meetings } = readNotebook();
    const split = needSplit();
    let total = 0;
    for (const id of [...split.dev, ...split.test]) {
      const m = meetings.find((x) => x.id === id);
      const items = nextStepItems(m.summary);
      mkdirSync(path('runs/baseline'), { recursive: true, mode: 0o700 });
      write(`runs/baseline/${id}.json`, { meetingId: id, ok: true, items });
      total += items.length;
    }
    console.log({ run: 'baseline', items: total });
  },

  async extract() {
    const split = needSplit();
    const run = option('--run');
    if (!run) throw new Error('--run is required.');
    const model = option('--model', 'sonnet');
    const { meetings } = readNotebook();
    mkdirSync(path(`runs/${run}`), { recursive: true, mode: 0o700 });
    const ids = chosen(split).filter((id) => {
      const saved = read(`runs/${run}/${id}.json`);
      return !saved?.ok;
    });
    const claude = new ClaudeCode({ workDir: path('claude-work') });
    const status = await claude.refresh();
    if (!status.ready) throw new Error(status.error ?? 'Claude is not signed in with a plan.');
    const instructions =
      todoInstructions +
      (flag('--wide')
        ? '\n\nFor this pass, list too much rather than too little: every commitment, request, follow-up, intention or implied next step you can find, however weak, for anyone.'
        : '') +
      (existsSync(path(`prompts/${run}.txt`))
        ? `\n\n${readFileSync(path(`prompts/${run}.txt`), 'utf8')}`
        : '');
    let failed = 0;
    const queue = [...ids];
    const worker = async () => {
      while (queue.length) {
        const id = queue.shift();
        const m = meetings.find((x) => x.id === id);
        const started = Date.now();
        try {
          const answer = await claude.respond({
            model,
            instructions,
            input: [{ role: 'user', content: todoRequest(m, split.names) }],
          });
          const parsed = parseTodoResponse(answer);
          const items = proposedTodos(m, parsed, split.names).map((item, i) => ({
            ...item,
            said: parsed[i].assignee,
            why: parsed[i].why,
          }));
          write(`runs/${run}/${id}.json`, {
            meetingId: id,
            ok: true,
            model,
            ms: Date.now() - started,
            items,
          });
          console.log(`done ${ids.length - queue.length}/${ids.length}: ${items.length} items`);
        } catch (error) {
          failed++;
          write(`runs/${run}/${id}.json`, { meetingId: id, ok: false, error: error.message });
          console.log(`failed ${ids.length - queue.length}/${ids.length}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Number(option('--parallel', 2)) }, worker));
    const after = readNotebook().fingerprint;
    const { before } = read('fingerprint.json', {});
    console.log({ requests: ids.length, failed, notebookUnchanged: after === before });
  },

  // What the app itself found, once the user has run it: the ChatGPT side of the comparison.
  chatgpt() {
    const split = needSplit();
    const { todos } = readNotebook();
    mkdirSync(path('runs/chatgpt'), { recursive: true, mode: 0o700 });
    let total = 0;
    for (const id of [...split.dev, ...split.test]) {
      const items = todos.filter((todo) => todo.meetingId === id);
      write(`runs/chatgpt/${id}.json`, { meetingId: id, ok: true, items });
      total += items.length;
    }
    console.log({ run: 'chatgpt', items: total });
  },

  pool() {
    const split = needSplit();
    const runs = option('--runs', '').split(',').filter(Boolean);
    let candidates = read('candidates.json', []);
    const before = candidates.length;
    for (const run of runs)
      for (const id of chosen(split)) {
        const saved = read(`runs/${run}/${id}.json`);
        if (saved?.ok) candidates = poolItems(candidates, run, id, saved.items);
      }
    write('candidates.json', candidates);
    const labels = read('labels.json', {});
    console.log({
      tasks: candidates.length,
      new: candidates.length - before,
      toLabel: candidates.filter((c) => !labels[c.id]?.label && !labels[c.id]?.dupOf).length,
    });
  },

  label() {
    const split = needSplit();
    const { meetings } = readNotebook();
    const set = new Set(chosen(split));
    const token = randomBytes(24).toString('hex');
    const only = option('--only')?.split(',');
    const page = () => {
      const candidates = read('candidates.json', []).filter((c) => set.has(c.meetingId));
      const labels = read('labels.json', {});
      const open = (c) =>
        !only ||
        (!labels[c.id]?.label &&
          !labels[c.id]?.dupOf &&
          c.members.some((key) => only.includes(key.split('/')[0])));
      const groups = shuffled([...set], split.seed)
        .map((id) => {
          const m = meetings.find((x) => x.id === id);
          return {
            id,
            title: m.title,
            date: m.createdAt.slice(0, 10),
            participants: m.participants,
            transcript: m.transcript.map((s) => [s.timestamp, s.speaker, s.text]),
            audit: split.audit.includes(id),
            // In order of when they were said, so two wordings of one thing sit together.
            tasks: candidates
              .filter((c) => c.meetingId === id)
              .sort(
                (a, b) => (a.evidence?.timestamp ?? Infinity) - (b.evidence?.timestamp ?? Infinity),
              )
              .filter(open)
              .map(({ id, text, evidence }) => ({ id, text, evidence })),
            // Everything in the meeting, labelled or not, so a repeat can name what it repeats.
            all: candidates.filter((c) => c.meetingId === id).map(({ id, text }) => ({ id, text })),
          };
        })
        .filter((group) => group.tasks.length || group.audit);
      return { groups, labels, missing: read('missing.json', {}) };
    };
    const server = createServer((request, response) => {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (url.searchParams.get('token') !== token) {
        response.writeHead(403).end();
        return;
      }
      const send = (type, body) => {
        response.writeHead(200, {
          'Content-Type': type,
          'Content-Security-Policy':
            "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'",
        });
        response.end(body);
      };
      if (request.method === 'GET' && url.pathname === '/')
        return send('text/html; charset=utf-8', labelPage);
      if (request.method === 'GET' && url.pathname === '/data')
        return send('application/json', JSON.stringify(page()));
      if (request.method === 'POST' && url.pathname === '/save') {
        let body = '';
        request.on('data', (chunk) => (body += chunk));
        request.on('end', () => {
          const { labels, missing } = JSON.parse(body);
          if (labels) write('labels.json', { ...read('labels.json', {}), ...labels });
          if (missing) write('missing.json', { ...read('missing.json', {}), ...missing });
          send('application/json', '{"ok":true}');
        });
        return;
      }
      response.writeHead(404).end();
    });
    server.listen(0, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${server.address().port}/?token=${token}`;
      console.log(url);
      if (!flag('--no-open')) execFile('open', [url]);
    });
    return new Promise(() => {});
  },

  score() {
    const split = needSplit();
    const run = option('--run');
    if (!run) throw new Error('--run is required.');
    const meetingIds = chosen(split);
    const candidates = read('candidates.json', []);
    const labels = read('labels.json', {});
    const missing = read('missing.json', {});
    const items = [];
    let failures = 0,
      requests = 0;
    for (const id of meetingIds) {
      const saved = read(`runs/${run}/${id}.json`);
      if (!saved) continue;
      requests++;
      if (!saved.ok) failures++;
      for (const [index, item] of (saved.items ?? []).entries())
        items.push({ meetingId: id, index, assignee: item.assignee });
    }
    const pooled = taskRows({ candidates, labels, run, items, meetingIds });
    const audited = taskRows({
      candidates,
      labels,
      run,
      items,
      meetingIds: meetingIds.filter((id) => split.audit.includes(id)),
      missing,
    });
    const interval = (rows, name) =>
      bootstrap(rows, (sample) => metrics(sample)[name], { seed: split.seed });
    const summary = (rows) => {
      const result = metrics(rows);
      return {
        ...result,
        intervals: Object.fromEntries(
          ['precisionMine', 'precisionList', 'recallStrict', 'recallList', 'flipRate'].map(
            (name) => [name, interval(rows, name)],
          ),
        ),
      };
    };
    const slice = (test) => summary(pooled.rows.filter((r) => test(split.meetings[r.meetingId])));
    const report = {
      run,
      set: option('--set', 'dev'),
      meetings: meetingIds.length,
      requests,
      failures,
      unlabeled: pooled.unlabeled,
      overall: summary(pooled.rows),
      precisionMineWilson: (() => {
        const said = pooled.rows.filter((r) => r.pred === 'me' && r.gold !== 'unsure');
        return wilson(said.filter((r) => r.gold === 'mine').length, said.length);
      })(),
      audited: {
        meetings: meetingIds.filter((id) => split.audit.includes(id)).length,
        ...summary(audited.rows),
      },
      bySides: {
        two: slice((m) => m.sides === 'two'),
        one: slice((m) => m.sides === 'one'),
      },
      byLanguage: { zh: slice((m) => m.language === 'zh'), en: slice((m) => m.language === 'en') },
      bySize: { pair: slice((m) => m.size === 'pair'), group: slice((m) => m.size === 'group') },
    };
    write(`report-${run}-${report.set}.json`, report);
    const percent = (x) => (x === null ? '–' : `${(x * 100).toFixed(0)}%`);
    const span = (x) => (x ? `${percent(x[0])}–${percent(x[1])}` : '–');
    const { overall: o, audited: a } = report;
    console.log({
      run,
      set: report.set,
      meetings: report.meetings,
      failures,
      unlabeled: report.unlabeled,
      tasks: o.tasks,
      mine: o.mine,
      listed: o.listed,
      precisionMine: `${percent(o.precisionMine)} (${span(o.intervals.precisionMine)})`,
      precisionList: `${percent(o.precisionList)} (${span(o.intervals.precisionList)})`,
      recallStrict: `${percent(o.recallStrict)} (${span(o.intervals.recallStrict)})`,
      recallList: `${percent(o.recallList)} (${span(o.intervals.recallList)})`,
      unclearShare: percent(o.unclearShare),
      unclearIsMine: percent(o.unclearIsMine),
      flipRate: `${percent(o.flipRate)} (${span(o.intervals.flipRate)})`,
      repeatRate: percent(o.repeatRate),
      errors: o.errors,
      auditedRecallList: `${percent(a.recallList)} over ${a.meetings} meetings`,
    });
    if (flag('--errors')) {
      // Text of wrong answers, for tuning only: refused for anything but the tuning set.
      if (report.set !== 'dev') throw new Error('Errors are only written for the tuning set.');
      const { meetings } = readNotebook();
      const wrong = [];
      for (const row of pooled.rows) {
        const listed = row.pred === 'me' || row.pred === 'unclear';
        if (row.gold === 'unsure' || (row.gold === 'mine' ? row.pred === 'me' : !listed)) continue;
        const candidate = candidates.find((c) => c.id === row.id);
        const key = candidate.members.find((k) => k.startsWith(`${run}/`));
        const saved =
          key && read(`runs/${run}/${row.meetingId}.json`).items[Number(key.split('/').at(-1))];
        const at = meetings.find((m) => m.id === row.meetingId).transcript;
        const near =
          candidate.evidence?.timestamp === undefined
            ? []
            : at
                .filter((s) => Math.abs(s.timestamp - candidate.evidence.timestamp) < 45)
                .map((s) => `${s.speaker}: ${s.text}`);
        wrong.push({
          gold: row.gold,
          said: row.pred,
          task: candidate.text,
          quote: candidate.evidence?.quote ?? null,
          why: saved?.why ?? null,
          modelSaid: saved?.said ?? null,
          near,
        });
      }
      write(`errors-${run}-dev.json`, wrong);
      console.log({ errorsWritten: wrong.length });
    }
    const { before } = read('fingerprint.json', {});
    console.log({ notebookUnchanged: readNotebook().fingerprint === before });
  },
};

const labelPage = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>待办标注</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root{color-scheme:light dark;--bg:#f8f7f3;--card:#fff;--ink:#1d1d1b;--muted:#64635d;--line:#e6e4dc;--on:#4f5d1c;--on-ink:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#1c1c1a;--card:#262624;--ink:#ecebe6;--muted:#a3a29b;--line:#33332f;--on:#c3cf4a;--on-ink:#1c1c1a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 -apple-system,BlinkMacSystemFont,sans-serif}
header{position:sticky;top:0;background:var(--bg);border-bottom:1px solid var(--line);padding:12px 16px}main{max-width:820px;margin:0 auto;padding:16px}
h1{font-size:16px;margin:0}h2{font-size:15px;margin:28px 0 4px}.meta{color:var(--muted);font-size:12px;margin:0 0 10px}
.task{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin:10px 0}.task.done{opacity:.72}
.text{font-size:15px;font-weight:500;margin:0 0 6px}.lines{color:var(--muted);font-size:12.5px;margin:6px 0;padding-left:10px;border-left:2px solid var(--line)}
.lines .hit{color:var(--ink);font-weight:500}.choices{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
button{font:inherit;border:1px solid var(--line);background:transparent;color:var(--ink);border-radius:999px;padding:4px 12px;cursor:pointer}
button.on{background:var(--on);border-color:var(--on);color:var(--on-ink)}select{font:inherit;max-width:100%;margin-top:8px}
details{margin:6px 0}summary{cursor:pointer;color:var(--muted);font-size:12.5px}pre{white-space:pre-wrap;font:12.5px/1.5 inherit;max-height:320px;overflow:auto}
textarea{width:100%;min-height:90px;font:inherit;background:var(--card);color:var(--ink);border:1px solid var(--line);border-radius:10px;padding:8px}
</style></head><body><header><h1>待办标注 <span id="count"></span></h1><p class="meta">判断每条事项到底是谁的。页面不显示模型的判断。点完自动保存，随时可以关掉再来。同一件事换了说法也算重复：选「和另一条重复」，只留一条打标签。</p></header><main id="root"></main>
<script>
const token=new URLSearchParams(location.search).get('token');
const choices=[['mine','我的'],['other','别人的'],['not_task','不是待办'],['unsure','说不准']];
let state;
const el=(tag,props={},...kids)=>{const n=Object.assign(document.createElement(tag),props);n.append(...kids);return n};
const clock=s=>Math.floor(s/60)+':'+String(Math.floor(s%60)).padStart(2,'0');
const save=b=>fetch('/save?token='+token,{method:'POST',body:JSON.stringify(b)});
function count(){const all=state.groups.flatMap(g=>g.tasks);const done=all.filter(t=>state.labels[t.id]?.label||state.labels[t.id]?.dupOf).length;document.getElementById('count').textContent=done+' / '+all.length}
function mineSoFar(group){const mine=group.all.filter(t=>state.labels[t.id]?.label==='mine').map(t=>t.text);group.box.textContent=mine.length?'本场标为「我的」：'+mine.join('；'):''}
function task(group,t){
  const box=el('div',{className:'task'});
  const paint=()=>{const l=state.labels[t.id]??{};box.classList.toggle('done',!!(l.label||l.dupOf));mineSoFar(group);
    box.querySelectorAll('[data-v]').forEach(b=>b.classList.toggle('on',l.label===b.dataset.v));
    const dup=box.querySelector('select');dup.value=l.dupOf??''};
  box.append(el('p',{className:'text',textContent:t.text}));
  if(t.evidence?.timestamp!==undefined){const near=group.transcript.filter(s=>Math.abs(s[0]-t.evidence.timestamp)<=30);
    const lines=el('div',{className:'lines'});for(const s of near){lines.append(el('div',{className:s[2]===t.evidence.quote?'hit':'',textContent:clock(s[0])+' '+s[1]+'：'+s[2]}))}box.append(lines)}
  else if(t.evidence?.quote)box.append(el('div',{className:'lines',textContent:'来自笔记：'+t.evidence.quote}));
  else box.append(el('div',{className:'lines',textContent:'没有原话，来自增强笔记。可以展开上面的完整转录核对。'}));
  const row=el('div',{className:'choices'});
  for(const [v,name] of choices){const b=el('button',{textContent:name});b.dataset.v=v;b.onclick=()=>{state.labels[t.id]={label:v};paint();count();save({labels:{[t.id]:state.labels[t.id]}})};row.append(b)}
  box.append(row);
  const dup=el('select',{},el('option',{value:'',textContent:'和另一条重复？选择它'}));
  for(const o of group.all)if(o.id!==t.id)dup.append(el('option',{value:o.id,textContent:o.text.slice(0,70)}));
  dup.onchange=()=>{state.labels[t.id]=dup.value?{dupOf:dup.value}:{};paint();count();save({labels:{[t.id]:state.labels[t.id]}})};
  box.append(dup);paint();return box}
fetch('/data?token='+token).then(r=>r.json()).then(s=>{state=s;const root=document.getElementById('root');
  for(const g of s.groups){root.append(el('h2',{textContent:g.title}),el('p',{className:'meta',textContent:g.date+(g.participants?' · '+g.participants:'')}));
    const full=el('details',{},el('summary',{textContent:'完整转录'}),el('pre',{textContent:g.transcript.map(x=>clock(x[0])+' '+x[1]+'：'+x[2]).join('\\n')}));root.append(full);
    g.box=el('p',{className:'meta'});root.append(g.box);
    for(const t of g.tasks)root.append(task(g,t));
    if(g.audit){const a=el('textarea',{value:(s.missing[g.id]??[]).join('\\n'),placeholder:'这场还有哪些分配给你的事没列出来？一行一条，没有就留空。'});a.onchange=()=>{const lines=a.value.split('\\n').map(x=>x.trim()).filter(Boolean);save({missing:{[g.id]:lines}})};root.append(el('h2',{textContent:'回看：这场有没有漏掉的？'}),a)}}
  count()});
</script></body></html>`;

const command = commands[process.argv[2]];
if (!command) {
  console.error(`Usage: node scripts/todo-accuracy.mjs ${Object.keys(commands).join('|')}`);
  process.exit(1);
}
await command();
