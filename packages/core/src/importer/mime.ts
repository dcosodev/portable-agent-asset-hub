// packages/core/src/importer/mime.ts
//
// Deterministic, narrow MIME detector used by the skill pack importer.
//
// The contract is "good enough for REST consumers" — we never depend
// on a library or `file --mime-type`. Binary files map to
// `application/octet-stream`; everything else falls through the
// extension table below and finally defaults to
// `application/octet-stream` for unknown extensions or extension-less
// files. UTF-8 text extensions without an extension default to
// `text/plain`.
//
// The detector is intentionally narrow so two runs over the same
// inputs always produce the same MIME strings (and therefore the same
// `planDigest`). The module is I/O-free.

const TEXT_EXTENSIONS: Record<string, string> = {
  md: 'text/markdown',
  markdown: 'text/markdown',
  txt: 'text/plain',
  json: 'application/json',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  toml: 'application/toml',
  xml: 'application/xml',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'application/javascript',
  mjs: 'application/javascript',
  cjs: 'application/javascript',
  ts: 'application/typescript',
  py: 'text/x-python',
  rb: 'text/x-ruby',
  rs: 'text/x-rust',
  go: 'text/x-go',
  java: 'text/x-java',
  kt: 'text/x-kotlin',
  swift: 'text/x-swift',
  c: 'text/x-c',
  h: 'text/x-c',
  cpp: 'text/x-c++',
  cc: 'text/x-c++',
  hpp: 'text/x-c++',
  sh: 'text/x-shellscript',
  bash: 'text/x-shellscript',
  zsh: 'text/x-shellscript',
  fish: 'text/x-shellscript',
  ps1: 'text/x-powershell',
  sql: 'text/x-sql',
  env: 'text/plain',
  ini: 'text/plain',
  conf: 'text/plain',
  log: 'text/plain',
  diff: 'text/x-diff',
  patch: 'text/x-diff',
};

const BINARY_EXTENSIONS: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  pdf: 'application/pdf',
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  tgz: 'application/gzip',
  bin: 'application/octet-stream',
  exe: 'application/octet-stream',
  dll: 'application/octet-stream',
  so: 'application/octet-stream',
  dylib: 'application/octet-stream',
  wasm: 'application/wasm',
};

/** Plain `text/*` mime types. Used to gate the secret scanner's text-only rules. */
export const TEXT_MIME_PREFIX = 'text/';
const TEXT_LIKE_MIME = new Set<string>([
  'application/json',
  'application/yaml',
  'application/xml',
  'application/toml',
  'application/javascript',
  'application/typescript',
]);

/**
 * Detect the MIME type from a relative POSIX path. The path is
 * inspected only by its lowercased basename extension. Files without
 * an extension return `application/octet-stream`.
 */
export function detectMime(relativePath: string): string {
  const lastSlash = relativePath.lastIndexOf('/');
  const basename = lastSlash >= 0 ? relativePath.slice(lastSlash + 1) : relativePath;
  const dot = basename.lastIndexOf('.');
  if (dot <= 0) return 'application/octet-stream';
  const ext = basename.slice(dot + 1).toLowerCase();
  return TEXT_EXTENSIONS[ext] ?? BINARY_EXTENSIONS[ext] ?? 'application/octet-stream';
}

/** True if the MIME is text-derived and therefore eligible for the secret scan. */
export function isTextMime(mime: string): boolean {
  if (mime.startsWith(TEXT_MIME_PREFIX)) return true;
  return TEXT_LIKE_MIME.has(mime);
}

/** Whitelist of relative path characters accepted for resources. */
export const SAFE_RESOURCE_PATH = /^[A-Za-z0-9._/+-]+$/u;

/** Governed directory segments that must be excluded from resources. */
export const GOVERNED_SEGMENTS = new Set(['node_modules', '.git', 'cache', 'backups', '.cache', '.backup', '.backups']);

export const SKILL_BASENAME = 'SKILL.md';
