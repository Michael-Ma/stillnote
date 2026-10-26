// Main-process unit harness only. No windows, native permissions, or network access.
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
export const app = new EventEmitter();
Object.assign(app, {
  isPackaged: false,
  paths: {},
  setName() {},
  setPath(key, value) {
    this.paths[key] = value;
  },
  getPath(key) {
    return this.paths[key] ?? '/tmp';
  },
  commandLine: { appendSwitch() {} },
  getPreferredSystemLanguages: () => ['en-US'],
  requestSingleInstanceLock: () => true,
  focus() {},
  whenReady: async () => {},
  quit() {},
  exit(code) {
    throw new Error(`App exited: ${code}`);
  },
});
export class BrowserWindow extends EventEmitter {
  static instances = [];
  constructor(options = {}) {
    super();
    this.options = options;
    BrowserWindow.instances.push(this);
    this.events = [];
    this.webContents = new EventEmitter();
    Object.assign(this.webContents, {
      mainFrame: {},
      isDestroyed: () => false,
      send: (_channel, event) => this.events.push(event),
      setWindowOpenHandler() {},
      session: { setPermissionRequestHandler() {} },
    });
  }
  isDestroyed() {
    return !!this.destroyed;
  }
  async loadFile(path) {
    this.webContents.mainFrame.url = pathToFileURL(path).href;
    this.loaded = true;
  }
  show() {}
  showInactive() {
    this.visible = true;
  }
  hide() {
    this.visible = false;
  }
  setBounds(bounds) {
    this.bounds = bounds;
  }
  setAlwaysOnTop() {}
  setOpacity() {}
  setIgnoreMouseEvents() {}
  focus() {}
  isFocused() {
    return true;
  }
  isMinimized() {
    return false;
  }
  restore() {}
  close() {
    let prevented = false;
    this.emit('close', {
      preventDefault() {
        prevented = true;
      },
    });
    if (!prevented) this.destroy();
  }
  destroy() {
    this.destroyed = true;
    this.emit('closed');
  }
}
export const ipcMain = {
  handlers: new Map(),
  handle(name, fn) {
    this.handlers.set(name, fn);
  },
};
export const safeStorage = {};
export const shell = { openExternal: async () => {}, openPath: async () => '' };
export const dialog = {
  showOpenDialog: async () => ({ canceled: true }),
  showSaveDialog: async () => ({ canceled: true }),
  showErrorBox(title, message) {
    throw new Error(`${title}: ${message}`);
  },
};
export const Menu = { buildFromTemplate: (items) => items, setApplicationMenu() {} };
export const screen = {
  getCursorScreenPoint: () => ({ x: 0, y: 0 }),
  getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 25, width: 1512, height: 920 } }),
};
export const powerSaveBlocker = { start: () => 1, stop() {} };
export const powerMonitor = { on() {} };
export const protocol = { registerSchemesAsPrivileged() {}, handle() {} };
