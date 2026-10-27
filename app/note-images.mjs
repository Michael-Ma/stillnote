// Images pasted or dropped into a note's own notes. The note text stays plain Markdown: each image
// is a Markdown image on a line of its own, ![image](stillnote-image://note/<meeting>/<file>), and
// its file lives in that meeting's folder beside its recordings, so deleting the note moves its
// images to the Trash with its audio. The editor shows the image in place of that line. Pure:
// shared by the main process, the editor and the tests.

export const imageTypes = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};
export const maxImageBytes = 20 * 1024 * 1024;

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const file = '[0-9a-f]{32}\\.(?:png|jpg|gif|webp)';
const images = () =>
  new RegExp(`!\\[[^\\]\\n]*\\]\\((stillnote-image://note/(${uuid})/(${file}))\\)`, 'g');

export const imageUrl = (meetingId, name) => `stillnote-image://note/${meetingId}/${name}`;
export const imageMarkdown = (url) => `![image](${url})`;

// The meeting and file a stillnote-image URL names, or null.
export function parseImageUrl(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    return null;
  }
  const parts = url.pathname.split('/').filter(Boolean);
  if (
    url.protocol !== 'stillnote-image:' ||
    url.hostname !== 'note' ||
    url.search ||
    url.hash ||
    parts.length !== 2 ||
    !new RegExp(`^${uuid}$`).test(parts[0]) ||
    !new RegExp(`^${file}$`).test(parts[1])
  )
    return null;
  return { meetingId: parts[0], name: parts[1] };
}

// The file extension for these bytes, by their signature: PNG, JPEG, GIF or WebP, else null. The
// clipboard's image/* type is not trusted.
export function imageType(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? []);
  const starts = (...signature) => signature.every((byte, i) => b[i] === byte);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'png';
  if (starts(0xff, 0xd8, 0xff)) return 'jpg';
  if (starts(0x47, 0x49, 0x46, 0x38)) return 'gif';
  if (starts(0x52, 0x49, 0x46, 0x46) && String.fromCharCode(...b.slice(8, 12)) === 'WEBP')
    return 'webp';
  return null;
}

// Every image a note's text shows, with where its Markdown is.
export function noteImages(text) {
  return [...String(text ?? '').matchAll(images())].map((m) => ({
    url: m[1],
    meetingId: m[2],
    name: m[3],
    from: m.index,
    to: m.index + m[0].length,
  }));
}

// The text with each image's Markdown replaced by what `replace` returns for it (its Markdown
// again when it returns null): the label an AI prompt or search sees, or an export's data URI.
export function replaceImages(text, replace) {
  return String(text ?? '').replace(images(), (whole, url, meetingId, name) => {
    const value = replace({ url, meetingId, name });
    return value ?? whole;
  });
}
export const withoutImages = (text, label = '[image]') => replaceImages(text, () => label);
