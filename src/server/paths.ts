import path from 'node:path';

export const rootDir = process.cwd();
export const dataDir = path.join(rootDir, 'data');
export const logsDir = path.join(rootDir, 'logs');
export const screenshotsDir = path.join(dataDir, 'screenshots');
export const chromeProfileDir = path.join(dataDir, 'chrome-profile');
export const dbPath = path.join(dataDir, 'macstudio-monitor.sqlite');
export const pidPath = path.join(dataDir, 'server.pid');
