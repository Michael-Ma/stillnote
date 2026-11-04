# Install Stillnote

## Download and open

1. Use an **Apple Silicon Mac** (M1 or newer). macOS 13 is the minimum target; macOS 26+ is recommended. This release has been tested on Apple Silicon, not on Intel or every supported macOS version.
2. Download `Stillnote-<version>-mac-arm64.dmg` from [GitHub Releases](https://github.com/Michael-Ma/stillnote/releases/latest).
3. Quit an existing Stillnote before updating. Open the DMG, drag **Stillnote.app** to **Applications**, and eject the disk image.
4. Open Stillnote from Applications. This community build is ad-hoc signed, **not signed with Developer ID or notarized by Apple**. If blocked, dismiss the alert and go to **System Settings → Privacy & Security → Open Anyway**, then confirm. Only do this for a release you trust. A code-signature verification or checksum is an integrity check, not Apple approval. Do not disable Gatekeeper or remove quarantine recursively.
5. In Settings connect ChatGPT or Claude for AI. Claude additionally needs the separately installed Claude Code CLI. Recording and manual notes work without AI sign-in. Grant microphone, speech recognition, system-audio and calendar permissions when using those features.

No source checkout, Node.js or Xcode is needed for the downloaded app. macOS may need to download speech models for your selected language.

## Ask your agent to install

Copy this prompt:

> Install Stillnote from https://github.com/Michael-Ma/stillnote/releases using the official prebuilt Apple Silicon ZIP, without building source. Read docs/INSTALL.md in that repo first. Verify my Mac and macOS version, resolve the latest release to an exact tag, download its ZIP and SHA256SUMS, and verify the matching SHA-256 before extracting. Quit an existing Stillnote normally and wait for it to exit before replacing the app; stop if it is recording or cannot quit. Preserve ~/Library/Application Support/Stillnote/ and all existing data. Stage and verify the new app before replacing the old one, with rollback on failure. Open /Applications/Stillnote.app afterward. If Gatekeeper blocks it, explain the first-open steps and let me confirm in System Settings. Do not disable Gatekeeper, strip quarantine or use sudo automatically. Tell me the installed version and whether launch succeeded.

For agents with GitHub CLI, the download sequence is:

```sh
# Work in a new temporary download directory. These commands do not install the app.
set -e
TAG=$(gh release view --repo Michael-Ma/stillnote --json tagName --jq .tagName)
gh release download "$TAG" --repo Michael-Ma/stillnote --pattern '*-mac-arm64.zip' --pattern SHA256SUMS
# Verify the ZIP line only: the DMG is a separate download.
awk '$2 ~ /-mac-arm64[.]zip$/ { print }' SHA256SUMS > ZIP-SHA256SUMS
test "$(wc -l < ZIP-SHA256SUMS | tr -d ' ')" = 1 && shasum -a 256 -c ZIP-SHA256SUMS
# Stop on any error; do not extract or install after a failed verification.
```

Use `ditto -x -k` to extract the verified ZIP, then `codesign --verify --deep --strict` on the app. The ZIP contains **Stillnote.app** at its root. Verify its bundle identifier (`local.stillnote.app`) and version against the release. Installation should copy into a temporary sibling in Applications, verify that copy, then rename the old app aside and move the staged app into place. Retain the previous app until the new launch succeeds. Never overwrite a running app or delete its notebook. If Applications is not writable, ask the user where to install rather than escalating silently.

Checksums from the same release detect corruption; they are not an independent publisher signature. CLI launch success does not establish that recording permissions or AI sign-in work. Keep the user involved in first-open approval and account sign-in.

## Updates and uninstall

Download a newer release and replace only the app after quitting it. There is no automatic updater. Notes, transcripts, recordings and settings live separately in `~/Library/Application Support/Stillnote/`. Quit Stillnote and back up that entire folder before an update if needed; JSON exports do not include recordings. Changing from a locally signed build can require granting permissions again.

To uninstall, quit Stillnote and move the app to Trash. Keep the data folder if you may return to it; removing it deletes local data.

## Build and publish an installer (maintainers)

Use a clean Apple Silicon checkout with Node.js 24+, macOS SDK 26+, and dependencies installed with `npm ci`:

```sh
npm test
npm run package:release
npm run test:install
npm run test:installer
```

`package:release` builds and ad-hoc signs the app without creating a signing identity, checks the packaged native helper and notebook UI with disposable data, then creates a DMG with an Applications shortcut, ZIP and `SHA256SUMS` under `release.noindex/`. The DMG also includes installation notes and the license. The directory is intentionally ignored by Git. Publish the three files together as assets on a versioned GitHub Release whose tag points to the source commit used to build them. Do not commit binary installers to Git history. Test an extracted ZIP and mounted DMG before publishing, and record the tested OS/architecture and lack of notarization in the release notes.

A later Developer ID release should use hardened-runtime signing and Apple notarization/stapling, with separate validation; the ad-hoc build command does not provide those. Mac App Store distribution needs a separate MAS/sandbox build and compatibility review of external CLI execution, capture and storage. Neither path is enabled by this installer work.
