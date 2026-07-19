import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  getServerPort: () => ipcRenderer.invoke('get-server-port'),
  setTitle: (title: string) => ipcRenderer.invoke('set-title', title),
  onServerReady: (callback: (event: any, data: { port: number }) => void) => {
    ipcRenderer.on('server-ready', callback);
    return () => ipcRenderer.off('server-ready', callback);
  },
  onUpdateAvailable: (callback: (event: any, data: { version: string }) => void) => {
    ipcRenderer.on('update-available', callback);
    return () => ipcRenderer.off('update-available', callback);
  },
  onUpdateProgress: (callback: (event: any, data: { percent: number; status?: string }) => void) => {
    ipcRenderer.on('update-progress', callback);
    return () => ipcRenderer.off('update-progress', callback);
  },
  onUpdateReady: (callback: (event: any, data: { version: string; extractDir: string }) => void) => {
    ipcRenderer.on('update-ready', callback);
    return () => ipcRenderer.off('update-ready', callback);
  },
  onUpdateError: (callback: (event: any, data: { message: string }) => void) => {
    ipcRenderer.on('update-error', callback);
    return () => ipcRenderer.off('update-error', callback);
  },
  applyUpdate: () => ipcRenderer.invoke('apply-update'),
});

declare global {
  interface Window {
    electronAPI?: {
      getServerPort: () => Promise<number>;
      setTitle: (title: string) => Promise<void>;
      onServerReady: (callback: (event: any, data: { port: number }) => void) => () => void;
      onUpdateAvailable: (callback: (event: any, data: { version: string }) => void) => () => void;
      onUpdateProgress: (callback: (event: any, data: { percent: number; status?: string }) => void) => () => void;
      onUpdateReady: (callback: (event: any, data: { version: string; extractDir: string }) => void) => () => void;
      onUpdateError: (callback: (event: any, data: { message: string }) => void) => () => void;
      applyUpdate: () => Promise<void>;
    };
  }
}
