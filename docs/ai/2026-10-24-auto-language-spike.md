# Auto meeting language: spike results (2026-10-24)

Question: can Stillnote pick Chinese or English **per sentence** by transcribing the same audio
with both languages and choosing between them? Apple's SpeechAnalyzer has no language
identification, so this is the only on-device route.

## Method

- `scripts/language-eval.mjs` (`npm run test:native:languages`) builds fixtures from macOS
  voices: Tingting (zh_CN) and Samantha (en_US), plus Eddy speaking both languages.
- The real helper transcribes each fixture once per candidate (`--locales zh-CN,en-US`) with
  the macOS 26 SpeechTranscriber, now with confidence and word timing per phrase.
- `app/language-arbiter.mjs` picks per sentence. Scoring: CER for Chinese sentences, WER for
  English, by word timing against the known sentence spans. The *oracle* takes every sentence
  from its own language's model, the best any per-sentence choice could do.
- Real candidate output is saved to `tests/fixtures/language-replay.json`; the unit test
  replays it.

## Results (error %, lower is better; language = sentences in the right language)

| Fixture | zh-CN only | en-US only | **Auto** | Oracle | Auto language |
| --- | --- | --- | --- | --- | --- |
| Chinese | 1.1 | 139.7 | **1.1** | 1.1 | 100% |
| English | 44.6 | 10.2 | **11.9** | 10.2 | 100% |
| Alternating sentences | 41.7 | 104.7 | **9.9** | 8.7 | 100% |
| Chinese with English terms | 12.8 | 102.7 | **12.8** | 12.8 | 100% |
| Alternating, 0.3 s pauses | 43.1 | 103.0 | **9.4** | 7.3 | 100% |
| One speaker, both languages | 47.6 | 88.4 | **27.8** | 25.3 | 100% |

Decision gate: **passed**. Auto beats both fixed languages on every mixed fixture by a wide
margin, matches the right fixed language on single-language audio (English +1.7 points), and
stays within 2.5 points of the oracle.

## What made it work

1. **Confidence is very discriminative**: 0.95–0.99 for the right model, 0.07–0.35 for an
   English model hearing Chinese. A Chinese model hearing English writes garbled Latin at
   ~0.5–0.7, caught by a script check (Han characters compared with Latin *words*, so
   "这个 feature 的 deadline" stays Chinese).
2. **The Chinese model returns very long phrases** (up to 19 s, several sentences in both
   languages). Word timing (`runs`) lets the arbiter cut every phrase at shared boundaries:
   any candidate's phrase edges plus *language switches inside phrases* (Han↔Latin in the
   Chinese model, confidence crossing 0.5 in the other).
3. **Groups are the time slices between those cuts**, not overlap chains (overlap chaining
   merged whole minutes into one decision).
4. Consecutive winning pieces of one phrase are stitched back (same row and id), and a
   garbled tail of the other language at a seam is dropped.

## Live recording (added the same day)

`npm run test:native:languages -- --live` streams each fixture in real time through the helper's
recording path: the first language starts with the recording, the second joins 1.5 s later and
catches up from a 10 s audio buffer, and the events are replayed with their real arrival times
through the live arbiter (`createLiveArbiter`).

| Fixture | Live Auto | Offline Auto | Oracle | Live language |
| --- | --- | --- | --- | --- |
| Chinese | 1.1 | 1.1 | 1.1 | 100% |
| English | 11.9 | 11.9 | 10.2 | 100% |
| Alternating | 8.0 | 10.8 | 8.7 | 100% |
| Chinese with English terms | 12.8 | 12.8 | 12.8 | 100% |
| Alternating, 0.3 s pauses | 8.1 | 9.4 | 7.3 | 100% |
| One speaker | 27.2 | 27.2 | 24.8 | 100% |

Two live-only problems had to be solved first:

- **Slow models.** The Chinese model produced its first result 12.5 s into a recording, so
  "a language that said nothing for 3.5 s heard silence" committed English garbage. The helper
  now reports each transcriber's finalized-through watermark (SpeechAnalyzer's volatile range,
  silence included) as `recognition-progress`; the arbiter waits for it and only gives up on a
  language that sent nothing at all for 15 s.
- **Moving provisional starts.** A growing phrase reports later and later start times, and the
  watermark can move past a phrase just before its final arrives. A phrase still showing
  provisional text holds the decision back, using the earliest start it ever reported.

## Limits and next steps

- Synthetic speech is clean; real meetings add noise, accents and crosstalk. Needs a real
  Chinese/English/mixed recording with the user before calling Auto done.
- Live mode runs two transcribers per source (four analyzers with meeting audio); system
  limits may refuse some. Both sources' first language is allocated before any second one,
  and a refused or failed second language falls back to the first for that source with one
  notice. Four analyzers on real meetings still need checking on the user's Mac.
- Final text in live mode waits for the slower model to finish a phrase (seconds); partials
  show the leading language meanwhile.
