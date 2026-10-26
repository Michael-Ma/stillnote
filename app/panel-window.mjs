// The floating panel's window (see app/panel.mjs for what it shows). One window, made when first
// needed and kept hidden between panels: a non-activating macOS panel at the top right of the
// display in use, above other apps and full-screen ones, that never takes focus from the call.
// A new panel replaces the one on screen; any choice in it closes it, then runs its action.
import { panelBounds, panelSize } from './panel.mjs';

export function panelWindow({
  BrowserWindow,
  Menu,
  screen,
  ipcMain,
  page,
  pageUrl,
  preload,
  // Scripted runs (tests) keep it invisible and click-through, like the main window.
  scripted = false,
  // Tests are told about each panel ({ show(panel, choose), menu(items) }) and choose in it; a
  // function, since the test adapter loads after this is made.
  observe = () => undefined,
}) {
  let window,
    ready,
    current,
    actions = {},
    serial = 0,
    // Once Stillnote's own window has gone, no panel opens again (it would keep Stillnote open).
    ended = false;
  function create() {
    window = new BrowserWindow({
      ...panelSize,
      type: 'panel',
      show: false,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false,
      acceptFirstMouse: true,
      alwaysOnTop: true,
      webPreferences: {
        preload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    window.setAlwaysOnTop?.(true, 'floating');
    if (scripted) {
      window.setOpacity?.(0);
      window.setIgnoreMouseEvents?.(true);
    }
    window.webContents.setWindowOpenHandler?.(() => ({ action: 'deny' }));
    window.webContents.on?.('will-navigate', (event) => event.preventDefault());
    window.on('closed', () => {
      window = undefined;
      ready = undefined;
    });
    ready = window.loadFile(page).then(
      () => window,
      (error) => {
        console.error('The reminder panel could not load:', error.message);
        window?.destroy();
        return undefined;
      },
    );
    return ready;
  }
  // Only the panel page, about the panel on screen, can choose.
  const fromPanel = (event) =>
    !!window &&
    event.sender === window.webContents &&
    event.senderFrame === window.webContents.mainFrame &&
    event.senderFrame?.url === pageUrl;
  // Hides the panel on screen, or only one that `match` accepts.
  function hide(match) {
    if (!current || (match && !match(current))) return;
    current = undefined;
    actions = {};
    if (window && !window.isDestroyed()) {
      window.webContents.send('stillnote-panel:show', null);
      window.hide();
    }
  }
  function choose(id, action) {
    if (!current || current.id !== id) return false;
    const run = actions[action];
    hide();
    try {
      run?.();
    } catch (error) {
      console.error('The panel action failed:', error.message);
    }
    return true;
  }
  ipcMain.handle('stillnote-panel:act', async (event, id, action) => {
    if (!fromPanel(event)) throw new Error('Unauthorized panel request.');
    return choose(id, String(action));
  });
  ipcMain.handle('stillnote-panel:menu', async (event, id, x, y) => {
    if (!fromPanel(event)) throw new Error('Unauthorized panel request.');
    if (!current || current.id !== id) return false;
    const items = current.menu.map((item) => ({
      label: item.label,
      click: () => choose(id, item.id),
    }));
    const observer = observe();
    if (observer) observer.menu?.(items);
    else
      Menu.buildFromTemplate(items).popup({
        window,
        x: Math.round(Number(x) || 0),
        y: Math.round(Number(y) || 0),
      });
    return true;
  });
  return {
    // `handlers` maps action ids ('open', the primary's, the menu's) to what they do.
    async show(panel, handlers = {}) {
      if (ended) return;
      const id = ++serial;
      current = { ...panel, id, shownAt: Date.now() };
      actions = handlers;
      observe()?.show?.(current, (action) => choose(id, action));
      try {
        const shown = await (ready ?? create());
        if (!shown || current?.id !== id || shown.isDestroyed()) return;
        const point = screen?.getCursorScreenPoint?.();
        const display = point
          ? screen.getDisplayNearestPoint(point)
          : screen?.getPrimaryDisplay?.();
        if (display?.workArea) shown.setBounds(panelBounds(display.workArea));
        shown.webContents.send('stillnote-panel:show', current);
        shown.showInactive();
      } catch (error) {
        console.error('The reminder panel could not open:', error.message);
      }
    },
    hide,
    current: () => current,
    destroy() {
      ended = true;
      current = undefined;
      if (window && !window.isDestroyed()) window.destroy();
    },
  };
}
