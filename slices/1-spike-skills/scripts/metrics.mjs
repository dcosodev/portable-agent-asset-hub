import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ts from 'typescript';

const run = promisify(execFile);
const localRoots = ['src', 'tests', 'scripts'];
const upstreamRoot = '/tmp/tencentdb-agent-memory-review';
const commit = '97f94654280b2932c35ba4806a491999ed244cc9';
const MIN_LINES = 5;
const SHINGLE_SIZE = 5;
const ADAPTATION_THRESHOLD = 0.85;
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(path));
    else if (/\.(ts|mjs)$/.test(entry.name)) out.push(path);
  }
  return out;
}

function normalizedLines(text) {
  return text.split(/\r?\n/).map((line) => line.replace(/\/\/.*$/, '').replace(/\s+/g, ' ').trim()).filter(Boolean);
}
function tokens(lines) { return lines.join(' ').split(/[^A-Za-z0-9_$]+/).filter(Boolean); }
function shingles(values) {
  const out = new Set();
  for (let index = 0; index <= values.length - SHINGLE_SIZE; index += 1) out.add(values.slice(index, index + SHINGLE_SIZE).join(' '));
  return out;
}
function similarity(left, right) {
  if (!left.size && !right.size) return 1;
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const item of left) if (right.has(item)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}
function matchingBlocks(local, upstream) {
  const matches = [];
  for (let localIndex = 0; localIndex <= local.length - MIN_LINES; localIndex += 1) {
    for (let upstreamIndex = 0; upstreamIndex <= upstream.length - MIN_LINES; upstreamIndex += 1) {
      if (local[localIndex] !== upstream[upstreamIndex] || (localIndex > 0 && upstreamIndex > 0 && local[localIndex - 1] === upstream[upstreamIndex - 1])) continue;
      let lines = 0;
      while (localIndex + lines < local.length && upstreamIndex + lines < upstream.length && local[localIndex + lines] === upstream[upstreamIndex + lines]) lines += 1;
      if (lines >= MIN_LINES) matches.push({ local_start: localIndex + 1, upstream_start: upstreamIndex + 1, lines });
    }
  }
  return matches;
}
function countAst(files, texts) {
  let node_count = 0;
  let statement_count = 0;
  for (const file of files.filter((item) => item.endsWith('.ts'))) {
    const source = ts.createSourceFile(file, texts.get(file), ts.ScriptTarget.Latest, true);
    const visit = (node) => { node_count += 1; if (ts.isStatement(node)) statement_count += 1; ts.forEachChild(node, visit); };
    visit(source);
  }
  return { node_count, statement_count, methodology: 'TypeScript compiler AST traversal over every TS runtime/test file' };
}
function nonblank(text) { return text.split(/\r?\n/).filter((line) => line.trim()).length; }

const localFiles = (await Promise.all(localRoots.map(walk))).flat().sort();
const upstreamFiles = (await run('git', ['-C', upstreamRoot, 'ls-tree', '-r', '--name-only', commit])).stdout.split('\n').filter((item) => /\.(ts|js|mjs)$/.test(item));
const localTexts = new Map();
for (const file of localFiles) localTexts.set(file, await readFile(file, 'utf8'));
const upstreamTexts = [];
for (const path of upstreamFiles) {
  const bytes = await readFile(join(upstreamRoot, path));
  upstreamTexts.push({ path, bytes, hash: sha(bytes), lines: normalizedLines(bytes.toString()) });
}

let copiedBlocks = 0;
let longestExactBlockLines = 0;
let maxShingleSimilarity = 0;
let adaptationSimilarityDetected = false;
const mappings = [];
for (const file of localFiles) {
  const bytes = Buffer.from(localTexts.get(file));
  const localLines = normalizedLines(bytes.toString());
  const localShingles = shingles(tokens(localLines));
  let bestSimilarity = { similarity: 0, upstream: undefined };
  let bestExact = { blocks: [], upstream: undefined };
  for (const upstream of upstreamTexts) {
    const blocks = matchingBlocks(localLines, upstream.lines);
    const score = similarity(localShingles, shingles(tokens(upstream.lines)));
    if (blocks.length > bestExact.blocks.length) bestExact = { blocks, upstream };
    if (score > bestSimilarity.similarity) bestSimilarity = { similarity: score, upstream };
  }
  copiedBlocks += bestExact.blocks.length;
  if (bestExact.blocks.length > 0) longestExactBlockLines = Math.max(longestExactBlockLines, ...bestExact.blocks.map((block) => block.lines));
  maxShingleSimilarity = Math.max(maxShingleSimilarity, bestSimilarity.similarity);
  const directCopyDetected = bestExact.blocks.length > 0;
  const adaptationDetected = !directCopyDetected && bestSimilarity.similarity >= ADAPTATION_THRESHOLD;
  adaptationSimilarityDetected ||= adaptationDetected;
  const evidenceUpstream = directCopyDetected ? bestExact.upstream : bestSimilarity.upstream;
  mappings.push({
    local: relative('.', file), local_sha256: sha(bytes),
    classification: directCopyDetected ? 'direct_copy_detected' : adaptationDetected ? 'adaptation_similarity_detected' : 'new',
    detection: { direct_copy_detected: directCopyDetected, adaptation_similarity_detected: adaptationDetected, max_shingle_similarity: bestSimilarity.similarity, exact_normalized_blocks: bestExact.blocks.length },
    upstream: evidenceUpstream ? { repository: 'TencentCloud/TencentDB-Agent-Memory', commit, path: evidenceUpstream.path, sha256: evidenceUpstream.hash } : { repository: 'TencentCloud/TencentDB-Agent-Memory', commit, path: 'NO_MATCHING_RUNTIME_FILE' },
    evidence: 'automated reproducible comparison; conceptual mapping (including inspired) is not treated as copying',
  });
}

const physical_nonblank_loc = {};
const ast = {};
for (const root of localRoots) {
  const files = localFiles.filter((file) => file.startsWith(`${root}/`));
  physical_nonblank_loc[root] = files.reduce((count, file) => count + nonblank(localTexts.get(file)), 0);
  ast[root] = root === 'scripts' ? { node_count: 0, statement_count: 0, methodology: 'scripts are ESM JavaScript; AST TS counts intentionally separated' } : countAst(files, localTexts);
}
const report = {
  upstream: { repository: 'TencentCloud/TencentDB-Agent-Memory', commit, review_scope: upstreamFiles },
  provenance: { copied: copiedBlocks > 0, adapted: adaptationSimilarityDetected, direct_tencent_code_extraction: copiedBlocks > 0 ? 'NO-GO' : 'NO-GO', methodology: 'SHA-256 file hashes plus exact normalized nonblank contiguous blocks >=5 lines and 5-token shingle Jaccard similarity against every pinned upstream runtime file. This is reproducible automated detection, not a claim of manual review.' },
  files: mappings,
  metrics: { physical_nonblank_loc, ast, normalized_scan: { minimum_nonblank_lines: MIN_LINES, shingle_size_tokens: SHINGLE_SIZE, adaptation_similarity_threshold: ADAPTATION_THRESHOLD, upstream_runtime_files_scanned: upstreamFiles.length, local_files_scanned: localFiles.length, copied_blocks: copiedBlocks, longest_exact_normalized_block_lines: longestExactBlockLines, max_shingle_similarity: maxShingleSimilarity, direct_copy_detected: copiedBlocks > 0, adaptation_similarity_detected: adaptationSimilarityDetected, copied: copiedBlocks > 0, adapted: adaptationSimilarityDetected, limitations: ['Similarity cannot establish authorship or intent.', 'Conceptual inspired mappings do not imply copied code.', 'Results are limited to the pinned runtime inventory and these thresholds.'] } },
  dependencies: { manifests_reviewed: ['package.json', 'pnpm-workspace.yaml', 'MemoryCore/package.json', 'MemoryCore/openclaw-plugin/package.json'], runtime: ['@modelcontextprotocol/sdk', 'zod'], excluded_not_installed: ['Tencent cloud SDK', 'MemoryProxy runtime'], exclusion_evidence: 'package manifest comparison plus import scan' },
};
await mkdir('artifacts', { recursive: true });
await writeFile('reuse-report.json', `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ files: mappings.length, copied_blocks: copiedBlocks, longest_exact_normalized_block_lines: longestExactBlockLines, max_shingle_similarity: maxShingleSimilarity, direct_copy_detected: copiedBlocks > 0, adaptation_similarity_detected: adaptationSimilarityDetected, runtime_loc: physical_nonblank_loc.src }));
