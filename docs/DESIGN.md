# UI/UX design

## Scope

A single-user macOS meeting notebook. The main task is to open a meeting, stay present while recording, jot down a few important points, then review enhanced notes and ask follow-up questions. Initial data is empty. Screenshots in this repository use explicitly fictional test fixtures, never imported personal meetings.

The design deliberately follows Granola's workflow, hierarchy and interaction patterns, without its team or cloud features. Stillnote does not use Granola's name, logos, illustrations or code.

## Reference mapping

References were re-checked on October 20, 2026 against the current Granola macOS app and its help center:

| Granola pattern | Stillnote decision |
| --- | --- |
| Home: search icon beside the window controls, Home / Chat, Spaces, a plan pill at the bottom | Same sidebar order; the pill shows which AI plan is in use and opens Settings. |
| “Coming up” card anchored on today, dashed separators between days, red dot on today | Same card, with “No more events today” and a “Start now” pill for a meeting that is about to begin. |
| Date-grouped rows with letter avatars or a document icon, time on the right | Same rows; no lock icon, because every note is local. |
| Note: serif title, small chips for date, attendees and folder | Same chips. Attendees and folder are editable in place. |
| Top-right switch between “My notes” and “Enhanced”, templates beside it | Segmented control plus a template menu in the top bar. Star, export and Trash sit next to it. |
| Enhanced notes: `#` heading markers, generated text in gray, the user's own points in black | Same treatment. A pure, deterministic matcher (`app/own-lines.mjs`) marks enhanced lines that restate the user's rough notes. |
| Bottom bar: listening pill on the left, “Ask anything” with a recipe chip | Same dock. The pill reads “Record”, “Resume” or shows live level bars and elapsed time. |
| Transcript one click away from the listening pill | A bare chevron hid it, so the pill carries labelled **Transcript** (line count, `⌘⇧T`) and, once audio is saved, **Recordings** buttons. Each opens its tab of a sheet above the dock. “You” bubbles sit on the right, meeting audio on the left. |
| “Analyzing transcript” progress with a Cancel pill | Same, while enhanced text streams in. |
| Chat: “Ask anything” composer with a model picker | Scope and model chips in the composer. The model picker spans every connected provider. |

## Layout

- **Home:** 232 px sidebar, a centered column up to 760 px, Coming up card, date-grouped rows, and a floating “Ask anything” dock.
- **Note:** the sidebar is hidden. A back pill and save state sit on the left of the top bar, view switch and note actions on the right. The writing column is up to 720 px.
- **Chat:** full width from the sidebar, or a 392 px side panel next to a note. Below 1100 px the side panel overlays the note instead of squeezing it.
- **Settings:** a dialog with AI, Recording and Notebook sections. AI shows one card per provider, with its status, usage and a single next step.

## Visual system

All colors, type sizes and radii are CSS custom properties in `app/style.css`, with a full dark theme under `prefers-color-scheme: dark`.

- Warm off-white canvas (`--bg #f8f7f3`), white surfaces, a slightly darker sidebar.
- Near-black ink. Secondary text `--muted #64635d` (5.6:1 on the canvas, WCAG AA); `--faint` is reserved for placeholders and decoration. Generated text `--ai-text`.
- Dark pill buttons for primary actions, as in Granola. An olive accent and a pale lime for citations and active states. A red dot only for live recording and today.
- System sans for UI (13 px base, 15 px writing and list titles); `ui-serif` (New York) for titles, headings and day numbers. Nothing below 11 px.
- Pill controls in the dock and top bar, 8 px controls, 12–20 px cards.
- Icon-only controls have accessible names. Native dialogs provide focus containment, Escape dismissal and return focus. Reduced-motion preferences disable transitions and animation.

## Principal states

1. Empty Home → New note → autosaved writing canvas.
2. Record → permissions/connecting → live level bars and elapsed time → stop → optional automatic enhancement.
3. Missing permissions or on-device language → visible recovery guidance. There is no silent cloud fallback.
4. Sparse transcript → one dismissible line under the title, with Listen and Retry.
5. No AI connected → an inline card with the shortest path: Use Claude (when Claude Code is signed in), Sign in to Claude, or Sign in with ChatGPT.
6. Enhanced note → own points in dark text, transcript additions lighter → transcript sheet from the dock → edit, regenerate, or restore an earlier version.
7. Chat → explicit scope and model → streamed answer → persisted message with source chips.
8. Quota, network failure or cancellation → visible recovery message. Notes and the previous summary stay intact.

## Meeting reminders

Like Granola, a connected calendar produces a reminder about a minute before each timed meeting (all-day events are skipped), in a floating panel at the top right rather than a system notification: a card with a bar in the calendar's own color, the meeting's title and time, a main button with Stillnote's icon, a chevron for more, and a thin bar along the bottom running down to when it goes by itself (a minute after the start, paused while the pointer is over it). It is configured as an always-on-top, non-activating macOS panel. Full-screen calls, multiple displays and Spaces still need device acceptance testing. When the event links to a Google Meet, Zoom or Teams call, the main button is **Join and take notes**: it brings Stillnote forward on the note for that occurrence — creating it from the event's title and attendees the first time — starts recording unless that is turned off in Settings › Recording, and opens the call last, once audio is being saved, so the meeting app ends up in front where Join is clicked; the menu has **Take notes without joining**. Without a link the main button is **Take notes**, and the menu can **Start Google Meet** or **Start Zoom** with the notes. Clicking the meeting's name only opens its note. Each occurrence of a recurring meeting gets its own reminder and note; Coming up reopens the same note.

## Starting and joining calls

- **Start meeting** sits beside New note on Home: one pill split into “Start Google Meet” (or Zoom, whichever was used last) and a chevron listing both services with the address each opens. One click opens a new call in the default browser or meeting app and records it, with meeting audio, in a new note titled “Google Meet · 2:05 PM”. Zoom starts through zoom.us's own Host-a-meeting link (`zoom.us/start/videomeeting`), the supported way to start an instant meeting without Zoom's retired client URL scheme or an OAuth integration.
- **Join & record** appears on Coming up rows whose event links to a call (marked with the service name next to the time): dark when the meeting is about to start, on hover otherwise. It opens the call and records in the occurrence's note. Rows without a link keep Take notes and Start now.

## Meeting detection

When a call app starts using the microphone and keeps it for a few seconds while Stillnote is not recording, Stillnote asks “Meeting detected — take notes?”: the floating panel, named after the calendar meeting under way when there is one, and a pill above the dock in the dock's own shape. Take notes in either records into that meeting's note, or a new “Meeting · 2:05 PM” note. Each call asks once at most, and a call Stillnote is already recording never asks. Apps that only record (macOS's screen and audio capture service, other note-takers such as Granola) are not calls, so they neither prompt nor keep a call that has ended looking under way. **Detect meetings** in Settings › Recording turns it off (on by default, as in Granola). **Open Stillnote when a meeting is detected** (off by default) also brings Stillnote forward onto the prompt, without starting a recording.

## Meeting end

Recordings used to run on after a call until someone remembered to stop them. While recording, “The meeting seems to be over” appears in the same pill shape above the dock, with its reason, when the call app lets go of the microphone (it held it for a minute) and nobody speaks for 10 seconds; when the calendar meeting has ended and nobody has spoken for two minutes; or when nobody has spoken for ten minutes (twenty while a call app still holds the microphone), once someone has spoken at all. These signals require quiet and are heuristic: a sufficiently long muted interval or missed transcript activity can still trigger a prompt. Renewed detected speech withdraws it; a call app taking the microphone again withdraws the call-release reason. By default it counts down 60 seconds and stops; **Keep recording** answers it until the signal happens again, and the stop notice offers **Resume recording** into the same note. The floating panel says the same, counting down, when Stillnote is not in front. On stop, everything from ten seconds after the last speech is cut when that is at least a minute and no track has sustained sound there, and the notice says how much went. This modifies the saved WAV files, so Retry cannot recover a successfully removed tail; short untranscribed sounds can be treated as silence. Failed track replacements roll back together. **When a meeting seems over** in Settings › Recording picks stopping after the countdown, only asking, or off (which also keeps the audio whole).

## Images in notes

Granola's notes take a pasted screenshot; a plain text box could not show one. **My notes** is now a CodeMirror editor that still holds plain Markdown, so nothing about existing notes changed: an image is a Markdown line of its own (`![image](stillnote-image://…)`) that the editor draws as the image itself, at its natural size up to the column width and 480 px high, with a thin border and rounded corners. Pasting or dropping image files saves them and adds each on a new line at the cursor, the cursor after it. The image moves and deletes as one character; Backspace at the start of the line below removes it, as in a rich editor, and Undo brings it back. Clicking shows it large on a dark backdrop until a click or Escape. Typing, undo, spell checking and Chinese input are the editor's own, as they were the text box's. Enhanced notes show an image only if its line is copied into them; the AI reads “[image]” in its place.

## AI providers in the UI

The provider in use is always named: in the sidebar pill, the chat footer and Settings. A Claude Code installation that is detected but never chosen can answer when the user clicks Enhance or sends a chat message, and that first use records the choice. Automatic enhancement after a recording runs only for a provider the user has chosen or signed in to.

## Recording review

The Recordings tab plays microphone and meeting audio with one transport, so the two stay aligned. Each source can be muted. Retry transcribes the saved audio again on the Mac. Recordings stay on this Mac and are excluded from model context and JSON backups.

## Application icon

A folded ivory paper ribbon forms an S on a forest-green macOS tile. See [ICON.md](ICON.md).

## Capture and recovery states

- Opening a notebook shows progress only while the state request is pending. A failed load shows the readable error and a Retry button.
- Recording settings list the Mac's microphones, including System default, and an opt-in, experimental echo cancellation (Off by default; headphones remain the recommended setup). Device changes apply to the next recording.
- Meeting language lists the native engine's supported locales using localized display names and marks installed models. Missing models have a Download action and labeled progress bar. The legacy engine lists the languages that work on this Mac and points to macOS Dictation settings. Unavailable device or language IPC shows a short local message; other settings remain usable.
- During capture, a warm warning chip above the dock says “No sound from <device>”. Change microphone opens Settings directly to Recording. Silent system audio uses a quieter “No meeting audio yet” chip. Each clears when its signal returns; stopping clears both. A device change gets a transient notice. These states also remain visible while chat is open.
- Transcript diagnostics name the input device and on-device recognition engine. Saved sessions show that information when available; older recordings do not guess missing metadata.
- Native warnings remain visible through autosave until dismissed or superseded. User cancellation says “Stopped.”; an AI timeout says “Timed out after 5 minutes. Your notes are unchanged.” Both use a quiet notice.
- Automatic enhancement opens the captured note only from Home or when already on that note. Elsewhere, a small notice offers Open, preserving the current editing location. AI streams remain attached to the note or chat scope where they began.
- Answers using a subset of the notebook show “Used N of M notes” below the answer. Applying an answer or restoring a summary explicitly preserves the previous version.
- Dialog backdrop dismissal requires the press and click to start and end on the backdrop. Dragging a text selection outside the dialog keeps the draft open.

All new chips, progress controls, and coverage labels use the existing color and type tokens, including the dark palette. The smallest label is 11 px.

## Demo provenance

`npm run demo` captures the real app with a disposable fictional notebook and synthetic native, calendar and AI transports. The MP4, GIF preview and poster under `docs/images/` carry a persistent fixture label. Floating panels are real app screenshots composited over the screencast, and meeting-end waits are compressed for the demonstration. The video establishes the displayed workflow; it does not measure recognition accuracy, live audio capture, account access, or native window placement. Still screenshots remain reproducible with `npm run screenshots`.
