import test from 'node:test';
import assert from 'node:assert/strict';
import {
  imageMarkdown,
  imageType,
  imageUrl,
  noteImages,
  parseImageUrl,
  replaceImages,
  withoutImages,
} from '../app/note-images.mjs';
import { tidyNotes } from '../app/meeting-context.mjs';
import { chatContext } from '../app/store.mjs';

const meetingId = '63f1fb32-ddc1-453f-900e-f488f6afb7c6',
  name = 'ed81d33f64164ed89b913a7de87601f0.png',
  url = imageUrl(meetingId, name),
  line = imageMarkdown(url);

test('an image URL names a meeting and one of Stillnote’s own files, nothing else', () => {
  assert.equal(url, `stillnote-image://note/${meetingId}/${name}`);
  assert.deepEqual(parseImageUrl(url), { meetingId, name });
  for (const bad of [
    `stillnote-image://other/${meetingId}/${name}`,
    `stillnote-image://note/${meetingId}/../${name}`,
    `stillnote-image://note/${meetingId}/%2e%2e/${name}`,
    `stillnote-image://note/${meetingId}/${name}?x=1`,
    `stillnote-image://note/${meetingId}/${name}#x`,
    `stillnote-image://note/${meetingId}/image.svg`,
    `stillnote-image://note/not-a-meeting/${name}`,
    `stillnote-image://note/${meetingId}/${name}/more`,
    `https://example.com/${name}`,
    'not a url',
  ])
    assert.equal(parseImageUrl(bad), null, bad);
});

test('images are recognized by their bytes, not the type the clipboard claims', () => {
  const bytes = (...b) => new Uint8Array([...b, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(imageType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)), 'png');
  assert.equal(imageType(bytes(0xff, 0xd8, 0xff, 0xe0)), 'jpg');
  assert.equal(imageType(bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61)), 'gif');
  assert.equal(imageType(new TextEncoder().encode('RIFF\u0000\u0000\u0000\u0000WEBPVP8 ')), 'webp');
  assert.equal(imageType(new TextEncoder().encode('RIFF\u0000\u0000\u0000\u0000WAVEfmt ')), null);
  assert.equal(
    imageType(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg">')),
    null,
  );
  assert.equal(imageType(new Uint8Array()), null);
  assert.equal(imageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer), null, 'too short');
});

test('a note’s images are found where their Markdown is, and replaced for prompts and exports', () => {
  const text = `Before\n${line}\nAfter ![photo](https://example.com/a.png)`;
  assert.deepEqual(noteImages(text), [{ url, meetingId, name, from: 7, to: 7 + line.length }]);
  assert.equal(withoutImages(text), 'Before\n[image]\nAfter ![photo](https://example.com/a.png)');
  assert.equal(withoutImages(text, ''), 'Before\n\nAfter ![photo](https://example.com/a.png)');
  assert.equal(
    replaceImages(text, () => null),
    text,
    'null keeps the image',
  );
  assert.equal(
    replaceImages(text, (image) => imageMarkdown(`data:image/png;base64,${image.name}`)),
    `Before\n![image](data:image/png;base64,${name})\nAfter ![photo](https://example.com/a.png)`,
  );
  assert.deepEqual(noteImages(null), []);
});

test('tidying a meeting context keeps the images in the notes', () => {
  const notes = `Meeting context\n<p>Agenda &amp; goals</p>\n${line}\nMy own line`;
  const tidied = tidyNotes(notes);
  assert.notEqual(tidied, notes, 'the invite was tidied');
  assert.ok(tidied.endsWith(`\n${line}\nMy own line`), tidied);
});

test('chat sources show where an image was, not its address', () => {
  const { source } = chatContext([
    {
      id: meetingId,
      title: 'Review',
      createdAt: '2026-10-26T18:00:00Z',
      notes: `Before\n${line}`,
      summary: '',
      transcript: [],
    },
  ]);
  assert.match(source, /"notes":"Before\\n\[image\]"/);
  assert.doesNotMatch(source, /stillnote-image/);
});
