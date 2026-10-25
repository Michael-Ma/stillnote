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
  whenReady: async () => {},
  quit() {},
  exit(code) {
    throw new Error(`App exited: ${code}`);
  },
});
export class BrowserWindow extends EventEmitter {
  static instances = [];
  constructor() {
    super();
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
  focus() {}
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
export const Notification = { isSupported: () => false };
export const powerSaveBlocker = { start: () => 1, stop() {} };
export const powerMonitor = { on() {} };
export const protocol = { registerSchemesAsPrivileged() {}, handle() {} };
