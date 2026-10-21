# UI/UX design

## Scope

A single-user macOS meeting notebook. The main task is to open a meeting, remain present while recording, jot down a few important points, then review an enhanced note and ask follow-up questions. Initial data is genuinely empty. Screenshots in this repository use explicitly fictional test fixtures, never imported personal meetings.

The user requested a close Granola-like experience with only the core capabilities. The design therefore follows Granola's workflow and hierarchy rather than building a new dashboard or reproducing its team/cloud features.

## Reference mapping

References were inspected on October 20, 2026:

| Granola reference | Adopted interaction or visual decision |
| --- | --- |
| [Granola 101](https://docs.granola.ai/help-center/getting-started/granola-101) | Narrow sidebar, Home/Chat, a personal space and folders, upcoming meetings above a chronological note feed. |
| [Writing your own notes](https://docs.granola.ai/help-center/taking-notes/taking-notes-in-granola) | A mostly blank document, serif title, compact participant/folder metadata, minimal writing chrome. |
| [AI-enhanced notes](https://docs.granola.ai/help-center/taking-notes/ai-enhanced-notes) | Human notes guide enhancement; raw notes remain accessible; templates and regeneration are nearby; generated notes remain editable. |
| [Chatting with meetings](https://docs.granola.ai/help-center/getting-more-from-your-notes/chatting-with-your-meetings) | A bottom chat entry, context determined by the current meeting/folder, cross-meeting questions, follow-up prompts. |

Reference screenshots were used for inspection only and are not redistributed. Stillnote does not use Granola's name as its app identity, logos, illustrations, or proprietary code.

## Chosen layout

- **Home:** 212 px sidebar, a centered content column up to 714 px, Coming up card, date-grouped meeting rows, fixed bottom chat entry.
- **Document:** hide the sidebar, keep a Home/back control, center a writing column up to 784 px, put capture and chat in a bottom dock.
- **Chat:** a full content view from Home, or a side panel when discussing a document. Scope remains explicit.
- **Settings:** native HTML dialog with account connection, language, capture preferences, and backup controls. No inactive cloud-integration navigation.

The first three-pane collection/editor layout and large illustrated welcome screen were removed because they diverged from the requested reference. Empty states now preserve the same Home structure that users see once they have notes.

## Visual system

- Warm near-white document canvas, pale neutral sidebar, charcoal text, muted gray/olive secondary text.
- Small teal calendar markers and restrained pale-green contextual chips.
- Native system sans for UI/body text; Georgia with serif fallback for document titles and section headings.
- 6–8 px corners for small controls; 16 px for the calendar card; a pill-shaped bottom composer.
- Icon-only controls have accessible names. Native dialogs provide focus containment, Escape dismissal, and return focus.
- Desktop layouts are checked at 1440×940 and 1024×768. Reduced-motion preferences disable transitions/animation. This is not a mobile web product or an accessibility certification.

## Principal states

1. Empty Home → Quick note → autosaved writing canvas.
2. Start recording → permissions/loading → listening with duration/input sources → finish → optional enhancement.
3. Missing permissions or on-device language → visible recovery guidance, no silent cloud fallback.
4. Enhanced note → inspect transcript citation → edit/regenerate → restore an earlier summary.
5. Home/meeting/folder chat → explicit source scope → streamed answer → completed persisted message.
6. Disconnected ChatGPT, quota/network failure, or cancellation → visible error; source notes and previous summary remain intact.
7. Search with zero results, folder assignment, Trash, restore, export, and backup.

The application has no production demo mode. Test screenshots may populate calendar/UI fixtures in an isolated test process; that is presentation verification, not evidence of a successful EventKit account connection.

## Application icon

Conversation Fold uses two overlapping ivory conversation cards on a forest-green macOS tile. The same mark appears in the Dock and workspace switcher. This replaces the initial generic notebook drawing. The canonical generated master, production exports, and complete built-in image-generation prompt are documented in [ICON.md](ICON.md).

## Recording review

The Recordings tab exposes separate microphone and system-audio controls with seeking and no autoplay, duration, recognition language, and retry. Input meters indicate signal only. Sparse-transcript notices offer a concrete listen/retry path, and legacy notes explain when no audio was saved. The raw notes remain optional and separate from all generated content. Recordings are retained on the Mac and excluded from model context and JSON backups.
