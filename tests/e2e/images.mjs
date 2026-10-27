// Images in My notes: a pasted screenshot shows in place between lines of text, deletes and comes
// back as one piece, survives a restart, and travels in exports and backups. The paste carries a
// PNG drawn in the page; the real clipboard is never touched.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync, readFileSync, statSync } from 'node:fs';

// Pastes a 640×280 PNG into My notes, or bytes that only claim to be one.
const paste = (page, fake = false) =>
  page.evaluate(async (fake) => {
    let blob = new Blob(['not an image'], { type: 'image/png' });
    if (!fake) {
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 280;
      const draw = canvas.getContext('2d');
      draw.fillStyle = '#4f5d1c';
      draw.fillRect(0, 0, 640, 280);
      draw.fillStyle = '#c3cf4a';
      draw.fillRect(40, 40, 260, 200);
      blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    }
    const data = new DataTransfer();
    data.items.add(new File([blob], 'Screenshot.png', { type: 'image/png' }));
    document
      .querySelector('.note-editor .cm-content')
      .dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
      );
  }, fake);

export async function images(h) {
  let page = await h.launch();
  const title = 'Design review with screenshots';
  const meeting = await h.create(title, 'Before the screenshot 截图之前');
  const notes = () => h.state().then((s) => s.meetings.find((m) => m.id === meeting.id).notes);
  const image = page.locator('.note-editor .note-image img');
  const loaded = () =>
    page.waitForFunction(
      () => document.querySelector('.note-editor .note-image img')?.naturalWidth === 640,
    );

  // Pasted at the end of a line, the image takes a line of its own and typing carries on below.
  await page.getByRole('textbox', { name: 'My notes', exact: true }).press('End');
  await paste(page);
  await loaded();
  await page.keyboard.type('After the screenshot 截图之后');
  await h.waitForState((s) =>
    s.meetings.find((m) => m.id === meeting.id).notes.endsWith('截图之后'),
  );
  const pasted = await notes();
  const [, name] =
    pasted.match(
      /^Before the screenshot 截图之前\n!\[image\]\(stillnote-image:\/\/note\/[0-9a-f-]{36}\/([0-9a-f]{32}\.png)\)\nAfter the screenshot 截图之后$/,
    ) ?? [];
  assert.ok(name, `unexpected notes: ${pasted}`);
  const file = join(h.dataDir, 'recordings', meeting.id, 'images', name);
  assert.ok(existsSync(file), 'the image is saved in the meeting’s folder');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  await page.screenshot({ path: join(h.output, 'image-in-notes.png') });

  // Backspace at the start of the line below deletes the whole image; Undo brings it back.
  await page.keyboard.press('Home');
  await page.keyboard.press('Backspace');
  await h.waitForState(
    (s, expected) => s.meetings.find((m) => m.id === meeting.id).notes === expected,
    'Before the screenshot 截图之前\nAfter the screenshot 截图之后',
  );
  assert.equal(await image.count(), 0);
  await page.keyboard.press('Meta+z');
  await h.waitForState(
    (s, expected) => s.meetings.find((m) => m.id === meeting.id).notes === expected,
    pasted,
  );
  await loaded();

  // Clicking the image shows it large until Escape.
  await image.click();
  const viewer = page.getByRole('dialog', { name: 'Image', exact: true });
  await viewer.waitFor();
  await page.keyboard.press('Escape');
  await viewer.waitFor({ state: 'hidden' });

  // Bytes that only claim to be an image are refused, and the notes stay as they were.
  await page.getByRole('textbox', { name: 'My notes', exact: true }).press('Meta+ArrowDown');
  await paste(page, true);
  await page
    .getByRole('alert')
    .getByText('Only PNG, JPEG, GIF or WebP images can be added.', { exact: true })
    .waitFor();
  assert.equal(await notes(), pasted);

  // Searching finds the words around the image, never its address.
  assert.ok((await h.call('search', '截图之后')).length > 0);
  assert.equal((await h.call('search', 'stillnote')).length, 0);

  // After a restart the image is still in place.
  page = await h.restart();
  await h.open(title);
  await loaded();
  assert.equal(
    await h.notesText(),
    'Before the screenshot 截图之前\nAfter the screenshot 截图之后',
  );

  // An export carries the image inside the file; a backup carries it beside the notes.
  const exportPath = join(h.output, 'screenshots.md');
  await h.saveDialog(exportPath);
  await page.getByRole('button', { name: 'Export Markdown', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Exported to' }).waitFor();
  const exported = readFileSync(exportPath, 'utf8');
  assert.match(exported, /截图之前\n!\[image\]\(data:image\/png;base64,iVBORw0KGgo/);
  assert.doesNotMatch(exported, /stillnote-image:/);
  const backupPath = join(h.output, 'screenshots.json');
  await h.saveDialog(backupPath);
  await h.call('backup');
  const backup = JSON.parse(readFileSync(backupPath, 'utf8'));
  assert.deepEqual(
    backup.images.map((item) => [item.meetingId, item.name]),
    [[meeting.id, name]],
  );
  assert.deepEqual(
    Buffer.from(backup.images[0].data, 'base64'),
    readFileSync(file),
    'the backup holds the image itself',
  );

  // A dropped image goes where it is dropped; any other dropped file is not read into the note.
  const drop = (kind) =>
    page.evaluate(async (kind) => {
      const canvas = Object.assign(document.createElement('canvas'), { width: 64, height: 64 });
      const blob =
        kind === 'image'
          ? await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
          : new Blob(['%PDF-1.7 not for the notes'], { type: 'application/pdf' });
      const data = new DataTransfer();
      data.items.add(new File([blob], `dropped.${kind === 'image' ? 'png' : 'pdf'}`, blob));
      const box = document.querySelector('.note-editor .cm-line').getBoundingClientRect();
      document.querySelector('.note-editor .cm-content').dispatchEvent(
        new DragEvent('drop', {
          dataTransfer: data,
          clientX: box.left + 2,
          clientY: box.top + box.height / 2,
          bubbles: true,
          cancelable: true,
        }),
      );
    }, kind);
  await drop('pdf');
  await drop('image');
  await page.locator('.note-editor .note-image img').nth(1).waitFor();
  const { notes: dropped } = (
    await h.waitForState((state) =>
      state.meetings.some((m) => m.id === meeting.id && noteImagesIn(m.notes) === 2),
    )
  ).meetings.find((m) => m.id === meeting.id);
  assert.doesNotMatch(dropped, /PDF/);
  h.assertNoRendererErrors();
}

const noteImagesIn = (text) => text.match(/!\[image\]\(stillnote-image:/g)?.length ?? 0;
