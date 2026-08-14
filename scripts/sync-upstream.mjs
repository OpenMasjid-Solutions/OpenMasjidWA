// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Track upstream OpenWA releases — for the DEV CHANNEL ONLY.
 *
 * ── WHY THIS NEVER TOUCHES STABLE ──────────────────────────────────────────────
 *
 * This repo packages someone else's software. An unattended job that moved every
 * masjid onto a brand-new third-party image the moment it appeared would be exactly
 * the supply-chain path OpenMasjidAPPS' own rules warn about: `main/catalog.json` is
 * production with no deploy step in between, so whatever this script decided at 05:23
 * would be live to every masjid by 05:24, reviewed by nobody.
 *
 * So the split is deliberate and is the whole design:
 *
 *   this script  →  the `dev` branch  →  dev catalog (hourly)  →  opted-in testers
 *   a human      →  a release tag     →  stable catalog        →  every masjid
 *
 * Promotion to stable stays a decision someone makes, having looked. That is not
 * caution for its own sake — it is the only review step in the chain.
 *
 * ── WHAT IT GUARANTEES ─────────────────────────────────────────────────────────
 *
 *  1. It pins a DIGEST, never a tag. A tag can be moved to different content; the
 *     digest is the content. This also satisfies the catalog's dev-entry contract.
 *  2. It refuses an image that is not on both linux/amd64 and linux/arm64 — a masjid
 *     on a Raspberry Pi must not be handed an amd64-only build.
 *  3. It keeps the dev version strictly AHEAD of the newest stable tag, because the
 *     catalog's freshness floor silently falls a dev entry back to stable otherwise —
 *     which would look exactly like "the update pipeline works" while shipping nothing.
 *
 * Usage: node scripts/sync-upstream.mjs [--dry-run]
 * Exits 0 with no changes when already current (the normal outcome).
 */
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const UPSTREAM = 'rmyndharis/OpenWA';
const IMAGE_REPO = 'rmyndharis/openwa'; // GHCR path is lowercase
const COMPOSE = 'docker-compose.yml';
const MANIFEST = 'manifest.yaml';
const DRY_RUN = process.argv.includes('--dry-run');

const die = (msg) => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};

async function json(url, headers = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) die(`${url} → HTTP ${res.status}`);
  return res.json();
}

/** The newest upstream release tag, e.g. "v0.18.0" → "0.18.0". */
async function latestUpstreamVersion() {
  const headers = { accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const rel = await json(`https://api.github.com/repos/${UPSTREAM}/releases/latest`, headers);
  const tag = String(rel.tag_name ?? '');
  const version = tag.replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+$/.test(version)) die(`upstream tag ${JSON.stringify(tag)} is not a plain X.Y.Z release`);
  return version;
}

/**
 * Resolve a tag to its immutable digest AND confirm the architectures, using the
 * anonymous OCI pull flow — the same one a masjid's Docker daemon uses, so if this
 * cannot see the image, neither can they.
 */
async function resolveImage(version) {
  const { token } = await json(
    `https://ghcr.io/token?scope=repository:${IMAGE_REPO}:pull&service=ghcr.io`,
  );
  const accept = [
    'application/vnd.oci.image.index.v1+json',
    'application/vnd.docker.distribution.manifest.list.v2+json',
    'application/vnd.oci.image.manifest.v1+json',
    'application/vnd.docker.distribution.manifest.v2+json',
  ].join(', ');
  const url = `https://ghcr.io/v2/${IMAGE_REPO}/manifests/${version}`;
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token}`, accept },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) die(`image ${IMAGE_REPO}:${version} is not pullable (HTTP ${res.status})`);

  const digest = res.headers.get('docker-content-digest');
  if (!/^sha256:[0-9a-f]{64}$/.test(digest ?? '')) die(`registry returned no usable digest for ${version}`);

  const body = await res.json();
  const arches = (body.manifests ?? [])
    .map((m) => `${m.platform?.os}/${m.platform?.architecture}`)
    .filter((a) => !a.includes('unknown'));
  for (const need of ['linux/amd64', 'linux/arm64']) {
    if (!arches.includes(need)) {
      die(`${IMAGE_REPO}:${version} is missing ${need} (has: ${arches.join(', ') || 'none'}) — a masjid on a Pi could not run it`);
    }
  }
  return { digest, arches };
}

/** The newest stable release of THIS repo, so the dev version can stay ahead of it. */
function newestStableTag() {
  try {
    const out = execFileSync('git', ['tag', '--list', 'v*.*.*', '--sort=-v:refname'], {
      encoding: 'utf8',
    });
    const tag = out.split('\n').map((s) => s.trim()).filter(Boolean)[0];
    if (!tag) return null;
    const parts = tag.replace(/^v/, '').split('.').map(Number);
    return parts.length === 3 && parts.every(Number.isInteger) ? parts : null;
  } catch {
    return null;
  }
}

/**
 * Next dev version. Normally just bumps N in `X.Y.Z-dev.N`. But if a release has
 * happened since (so the base is no longer ahead of stable), it moves the minor —
 * otherwise the catalog's freshness floor would quietly serve stable instead, and the
 * dev channel would look updated while being a release behind.
 */
function nextDevVersion(current, stable) {
  const m = /^(\d+)\.(\d+)\.(\d+)-dev\.(\d+)$/.exec(current);
  if (!m) die(`manifest version ${JSON.stringify(current)} is not X.Y.Z-dev.N — refusing to guess`);
  let [major, minor, patch, n] = m.slice(1).map(Number);
  n += 1;
  if (stable) {
    const [sMaj, sMin, sPat] = stable;
    const behind =
      major < sMaj ||
      (major === sMaj && minor < sMin) ||
      (major === sMaj && minor === sMin && patch <= sPat);
    if (behind) {
      major = sMaj;
      minor = sMin + 1;
      patch = 0;
      n = 1;
      console.log(`  ↑ base moved to ${major}.${minor}.${patch} — stable is now v${stable.join('.')}`);
    }
  }
  return `${major}.${minor}.${patch}-dev.${n}`;
}

// ── run ─────────────────────────────────────────────────────────────────────────

const composeText = readFileSync(COMPOSE, 'utf8');
const manifestText = readFileSync(MANIFEST, 'utf8');

const currentImage = /^\s*image:\s*(\S+)\s*$/m.exec(composeText)?.[1];
if (!currentImage) die(`no image: line found in ${COMPOSE}`);
const currentDigest = /@(sha256:[0-9a-f]{64})/.exec(currentImage)?.[1];

const version = await latestUpstreamVersion();
const { digest, arches } = await resolveImage(version);

console.log(`upstream latest : ${version}`);
console.log(`resolved digest : ${digest}  (${arches.join(', ')})`);
console.log(`currently pinned: ${currentDigest ?? '(none)'}`);

if (digest === currentDigest) {
  console.log('✓ already current — nothing to do.');
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, 'changed=false\n');
  process.exit(0);
}

const nextImage = `ghcr.io/${IMAGE_REPO}:${version}@${digest}`;
const currentVersion = /^version:\s*(\S+)\s*$/m.exec(manifestText)?.[1];
if (!currentVersion) die(`no version: line found in ${MANIFEST}`);
const nextVersion = nextDevVersion(currentVersion, newestStableTag());

const nextCompose = composeText
  .replace(/^(\s*)#\s*ghcr\.io\/.*$/m, `$1# ghcr.io/${IMAGE_REPO}:${version}`)
  .replace(/^(\s*image:\s*)\S+\s*$/m, `$1${nextImage}`);
const nextManifest = manifestText.replace(/^version:\s*\S+\s*$/m, `version: ${nextVersion}`);

console.log(`\nOpenWA  ${currentImage.split('@')[0].split(':').pop()} → ${version}`);
console.log(`package ${currentVersion} → ${nextVersion}`);

if (DRY_RUN) {
  console.log('\n(dry run — nothing written)');
  process.exit(0);
}

writeFileSync(COMPOSE, nextCompose);
writeFileSync(MANIFEST, nextManifest);

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `changed=true\nupstream=${version}\nversion=${nextVersion}\ndigest=${digest}\n`,
  );
}
console.log('\n✓ written.');
