import React, { useEffect, useRef } from 'react';
import { EditorState, StateField } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, keymap, placeholder } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { imageMarkdown, noteImages } from '../note-images.mjs';

// The editor for a note's own notes: plain Markdown text like the textarea it replaced, except
// that an image's Markdown line shows as the image (app/note-images.mjs). An image moves and
// deletes as one character; pasting or dropping image files saves them and adds their lines at
// the cursor. Undo, spell checking and input methods (Chinese, Japanese) are the browser's and
// CodeMirror's own.
class ImageWidget extends WidgetType {
  constructor(url) {
    super();
    this.url = url;
  }
  eq(other) {
    return other.url === this.url;
  }
  toDOM(view) {
    const frame = document.createElement('span');
    frame.className = 'note-image';
    frame.dataset.url = this.url;
    const image = document.createElement('img');
    image.src = this.url;
    image.alt = '';
    image.draggable = false;
    // A loaded image changes the line's height.
    image.onload = image.onerror = () => view.requestMeasure();
    frame.append(image);
    return frame;
  }
  ignoreEvent() {
    return false;
  }
}
const images = StateField.define({
  create: (state) => decorate(state.doc.toString()),
  update: (value, tr) => (tr.docChanged ? decorate(tr.state.doc.toString()) : value),
  provide: (field) => [
    EditorView.decorations.from(field),
    EditorView.atomicRanges.of((view) => view.state.field(field)),
  ],
});
// An image on a line of its own (as pasted) takes the whole line as a block; one with text
// beside it (typed there later) stays inline.
function decorate(text) {
  return Decoration.set(
    noteImages(text).map(({ url, from, to }) =>
      Decoration.replace({
        widget: new ImageWidget(url),
        block: (from === 0 || text[from - 1] === '\n') && (to === text.length || text[to] === '\n'),
      }).range(from, to),
    ),
  );
}

// Backspace at the start of the line after an image deletes the image and its line, as in a rich
// editor, instead of pulling the text up beside it.
function deleteImageBefore(view) {
  const { state } = view,
    { empty, head } = state.selection.main,
    line = state.doc.lineAt(head);
  if (!empty || head !== line.from || line.number === 1) return false;
  const previous = state.doc.line(line.number - 1);
  if (!noteImages(previous.text).some((image) => image.from === 0 && image.to === previous.length))
    return false;
  view.dispatch({
    changes: { from: previous.from, to: line.from },
    scrollIntoView: true,
    userEvent: 'delete.backward',
  });
  return true;
}

// Image files on the clipboard or in a drop, in their order.
const imageFiles = (transfer) =>
  [...(transfer?.files ?? [])].filter((item) => item.type.startsWith('image/'));

// Each image goes on a line of its own at `at`, and the cursor after it.
async function addImages(view, files, at, save) {
  for (const item of files) {
    const url = await save(new Uint8Array(await item.arrayBuffer()));
    if (!url || !view.dom.isConnected) return;
    const pos = Math.min(at ?? view.state.selection.main.head, view.state.doc.length),
      line = view.state.doc.lineAt(pos),
      insert = `${pos > line.from ? '\n' : ''}${imageMarkdown(url)}\n`;
    view.dispatch({
      changes: { from: pos, insert },
      selection: { anchor: pos + insert.length },
      scrollIntoView: true,
      userEvent: 'input.paste',
    });
    at = null;
  }
}

export function NoteEditor({ value, onChange, label, hint, onSaveImage, onOpenImage }) {
  const host = useRef(null),
    view = useRef(null),
    props = useRef({});
  props.current = { onChange, onSaveImage, onOpenImage };
  useEffect(() => {
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          keymap.of([
            { key: 'Backspace', run: deleteImageBefore },
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          EditorView.lineWrapping,
          placeholder(hint),
          EditorView.contentAttributes.of({
            'aria-label': label,
            spellcheck: 'true',
            autocorrect: 'on',
          }),
          images,
          EditorView.updateListener.of((update) => {
            if (update.docChanged) props.current.onChange(update.state.doc.toString());
          }),
          EditorView.domEventHandlers({
            paste(event, target) {
              const files = imageFiles(event.clipboardData);
              if (!files.length || !props.current.onSaveImage) return false;
              event.preventDefault();
              void addImages(target, files, null, props.current.onSaveImage);
              return true;
            },
            // Dropped files never go in as text (CodeMirror would read a PDF into the note): only
            // images are added, and only where a note can take them.
            drop(event, target) {
              if (!event.dataTransfer?.files?.length) return false;
              event.preventDefault();
              const files = imageFiles(event.dataTransfer);
              if (!files.length || !props.current.onSaveImage) return true;
              const at = target.posAtCoords({ x: event.clientX, y: event.clientY });
              void addImages(target, files, at, props.current.onSaveImage);
              return true;
            },
            click(event) {
              const url = event.target.closest?.('.note-image')?.dataset.url;
              if (!url) return false;
              props.current.onOpenImage?.(url);
              return true;
            },
          }),
        ],
      }),
    });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
    // Made once per note (the caller keys it by note); later `value` changes follow below.
  }, []);
  // A change made elsewhere (tidying an invite, undoing that) replaces the text; the editor's own
  // edits come back here unchanged and are left alone.
  useEffect(() => {
    const editor = view.current;
    if (editor && value !== editor.state.doc.toString())
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } });
  }, [value]);
  return <div className="note-editor" ref={host} />;
}
