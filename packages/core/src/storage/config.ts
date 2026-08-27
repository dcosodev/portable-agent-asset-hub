import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, normalize, resolve } from 'node:path';

export type StorageMode = 'canonical' | 'temporary' | 'test';
export type StorageSource = 'explicit-cli' | 'explicit-env' | 'configured-data-dir' | 'default-persistent' | 'temporary-default';

export type HubDatabaseResolution = {
  path: string;
  source: StorageSource;
  mode: StorageMode;
  isTemporary: boolean;
  databaseName: string;
};

export type ResolveHubDatabaseOptions = {
  cliPath?: string;
  env?: Readonly<Record<string, string | undefined>>;
  cwd?: string;
  platform?: NodeJS.Platform;
  homeDir?: string;
  tempDir?: string;
};

const DB_PATH_ENV = 'AGENT_MEMORY_DB_PATH';
const DATA_DIR_ENV = 'AGENT_MEMORY_DATA_DIR';
const STORAGE_MODE_ENV = 'AGENT_MEMORY_STORAGE_MODE';
const CONFIGURED_DATA_DIR_ENV = 'PORTABLE_AGENT_ASSET_HUB_DATA_DIR';
const APP_DIR_NAME = 'portable-agent-asset-hub';

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function configuredPersistentDataDir(options: ResolveHubDatabaseOptions): string | undefined {
  const env = options.env ?? process.env;
  return clean(env[DATA_DIR_ENV]) ?? clean(env[CONFIGURED_DATA_DIR_ENV]);
}

function defaultPersistentDataDir(options: ResolveHubDatabaseOptions): string {
  const home = options.homeDir ?? homedir();
  if ((options.platform ?? process.platform) === 'darwin') return join(home, 'Library', 'Application Support', APP_DIR_NAME);
  const env = options.env ?? process.env;
  return join(clean(env.XDG_DATA_HOME) ?? join(home, '.local', 'share'), APP_DIR_NAME);
}

function temporaryPath(path: string, options: ResolveHubDatabaseOptions): boolean {
  const normalized = normalize(resolve(path));
  const tempRoot = normalize(resolve(options.tempDir ?? tmpdir()));
  if (normalized === tempRoot || normalized.startsWith(`${tempRoot}/`)) return true;
  if (normalized === '/tmp' || normalized.startsWith('/tmp/')) return true;
  if (normalized === '/var/tmp' || normalized.startsWith('/var/tmp/')) return true;
  const parts = normalized.split('/').filter(Boolean).map((part) => part.toLowerCase());
  return parts.includes('test') || parts.includes('tests') || parts.includes('e2e') || parts.includes('fixtures');
}

function explicitMode(value: string | undefined): StorageMode | undefined {
  if (!value) return undefined;
  if (value === 'canonical' || value === 'temporary' || value === 'test') return value;
  throw new Error(`${STORAGE_MODE_ENV} must be canonical, temporary, or test`);
}

export function resolveHubDatabasePath(options: ResolveHubDatabaseOptions = {}): HubDatabaseResolution {
  const env = options.env ?? process.env;
  const cliPath = clean(options.cliPath);
  const envPath = clean(env[DB_PATH_ENV]);
  const configuredDir = configuredPersistentDataDir(options);
  const path = cliPath
    ? resolve(options.cwd ?? process.cwd(), cliPath)
    : envPath
      ? resolve(options.cwd ?? process.cwd(), envPath)
      : configuredDir
        ? join(resolve(options.cwd ?? process.cwd(), configuredDir), 'hub.sqlite')
        : join(defaultPersistentDataDir(options), 'hub.sqlite');
  const source: StorageSource = cliPath ? 'explicit-cli' : envPath ? 'explicit-env' : configuredDir ? 'configured-data-dir' : 'default-persistent';
  const detectedTemporary = temporaryPath(path, options);
  const requestedMode = explicitMode(clean(env[STORAGE_MODE_ENV]));
  const mode = requestedMode ?? (detectedTemporary ? 'temporary' : 'canonical');
  if (mode === 'canonical' && detectedTemporary) throw new Error(`canonical storage cannot use a temporary path: ${path}`);
  if (mode === 'temporary' && !detectedTemporary && source === 'default-persistent') throw new Error(`temporary storage requires an explicit temporary database path: ${path}`);
  return { path, source: mode === 'temporary' && source === 'default-persistent' ? 'temporary-default' : source, mode, isTemporary: mode !== 'canonical', databaseName: basename(path) };
}

export function redactDatabasePath(path: string): string {
  return `${basename(dirname(path))}/${basename(path)}`;
}

export function requireCanonicalStorage(resolution: HubDatabaseResolution): void {
  if (resolution.mode !== 'canonical') throw new Error('Canonical write refused: runtime is using temporary storage');
}

export const HUB_STORAGE_ENV = Object.freeze({ DB_PATH_ENV, DATA_DIR_ENV, STORAGE_MODE_ENV, CONFIGURED_DATA_DIR_ENV });
export const DEFAULT_PERSISTENT_DATA_DIR_NAME = APP_DIR_NAME;
