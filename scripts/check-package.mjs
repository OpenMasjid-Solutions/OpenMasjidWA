// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The invariants this package must hold, checked locally so a breakage is caught here
 * rather than in the catalog build (by which point the branch has already moved and
 * testers may have pulled it).
 *
 * These mirror OpenMasjidAPPS' own gates — CLAUDE.md §2, §3b and §4C. They are not a
 * substitute for the catalog build, which is authoritative; they are the fast copy.
 *
 * Usage: npm install --no-save yaml && node scripts/check-package.mjs
 */
import { readFileSync } from 'node:fs';
import YAML from 'yaml';

const problems = [];
const check = (ok, msg) => {
  if (!ok) problems.push(msg);
};

const composeText = readFileSync('docker-compose.yml', 'utf8');
const manifestText = readFileSync('manifest.yaml', 'utf8');
const compose = YAML.parse(composeText);
const manifest = YAML.parse(manifestText);

// ── the platform contract ───────────────────────────────────────────────────────
check(manifest.id === 'openwa', `manifest id must be "openwa" (the platform hard-codes it), got ${JSON.stringify(manifest.id)}`);
check(/^[a-z0-9][a-z0-9-]{0,79}$/.test(String(manifest.id)), 'manifest id must be kebab-case');
check(typeof manifest.name === 'string' && manifest.name.trim() !== '', 'manifest name is required');
check(typeof manifest.version === 'string' && manifest.version.trim() !== '', 'manifest version is required');
check(
  ['displays', 'donations', 'community', 'quran', 'admin', 'utilities'].includes(manifest.category),
  `manifest category ${JSON.stringify(manifest.category)} is not one of the six`,
);

// The gateway holds a live WhatsApp session. It must never be offered to the internet,
// and it needs no Fabric capability of its own — the platform calls IN to it.
for (const forbidden of ['tunnel', 'sso', 'notifications', 'stripe', 'domain', 'email', 'whatsapp', 'fabric', 'https']) {
  check(manifest[forbidden] == null, `manifest must not set "${forbidden}" — this app is LAN-only and the platform calls in to it`);
}

// ── the image ───────────────────────────────────────────────────────────────────
const services = Object.keys(compose.services ?? {});
check(services.length === 1 && services[0] === 'openwa', `expected exactly one service named "openwa", got [${services.join(', ')}]`);

const svc = compose.services?.openwa ?? {};
const image = String(svc.image ?? '');
check(
  /^ghcr\.io\/rmyndharis\/openwa:\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/.test(image),
  `image must be the upstream image pinned by tag AND digest, got ${JSON.stringify(image)}`,
);

// ── the port the platform finds the gateway on ──────────────────────────────────
const ports = svc.ports ?? [];
check(ports.length >= 1, 'the web/API port must stay published — the platform reads ports[0] to find the gateway');
check(String(ports[0] ?? '').endsWith(':2785'), `ports[0] must map to container port 2785, got ${JSON.stringify(ports[0])}`);

// ── the session survives a restart ──────────────────────────────────────────────
const volumes = svc.volumes ?? [];
check(
  volumes.some((v) => String(v).endsWith(':/app/data')),
  'a named volume must be mounted at /app/data, or every restart forces a re-link',
);
check(compose.volumes != null && Object.keys(compose.volumes).length > 0, 'the named volume must be declared');
for (const [name, def] of Object.entries(compose.volumes ?? {})) {
  check(def == null || def.external !== true, `volume "${name}" must not be external — a listed app owns its storage`);
  check(def == null || def.name == null, `volume "${name}" must not pin an external name — the platform namespaces it`);
}

// ── least privilege (CLAUDE.md §4C) ─────────────────────────────────────────────
check(svc.privileged == null, 'privileged is refused at install');
check(svc.build == null, 'a listed app references a published image; it never builds on the masjid host');
for (const key of ['cap_add', 'devices', 'device_cgroup_rules', 'group_add', 'network_mode', 'pid', 'ipc', 'userns_mode', 'cgroup', 'uts']) {
  check(svc[key] == null, `"${key}" is refused at install`);
}
check(!/\/var\/run\/docker\.sock/.test(composeText), 'the Docker socket must never appear — not even in a comment; the catalog scans the raw text');
for (const v of volumes) {
  check(!String(v).startsWith('/') && !String(v).startsWith('.') && !String(v).includes('..'), `volume ${JSON.stringify(v)} bind-mounts a host path`);
}

// ── settings the compose actually consumes ──────────────────────────────────────
const referenced = new Set([...composeText.matchAll(/\$\{([A-Z0-9_]+)(?::-[^}]*)?\}/g)].map((m) => m[1]));
const declared = new Set((manifest.settings ?? []).map((s) => s.key));
for (const key of referenced) {
  check(declared.has(key), `compose interpolates \${${key}} but the manifest declares no such setting — the install dialog would never ask for it`);
}
for (const key of declared) {
  check(referenced.has(key), `manifest declares setting "${key}" that the compose never uses — it would be collected and silently ignored`);
}
check(declared.has('OPENWA_API_KEY'), 'the gateway key setting is missing');
check(
  (manifest.settings ?? []).find((s) => s.key === 'OPENWA_API_KEY')?.type === 'password',
  'the gateway key must be type: password',
);
check(
  !(manifest.settings ?? []).some((s) => s.key === 'OPENWA_API_KEY' && s.default != null),
  'the gateway key must NOT ship a default — a well-known key in a public catalog is the same key on every masjid',
);

// ── the decisions that are easy to undo by accident ─────────────────────────────
const env = (svc.environment ?? []).map(String);
const has = (line) => env.some((e) => e === line);
check(has('SEND_PACING_ENABLED=false'), "upstream's send pacer must stay off — the platform owns the one queue, and a 429 from a second governor is read as a dropped send");
check(has('CSP_UPGRADE_INSECURE_REQUESTS=false'), 'without this the setup page renders blank white over plain HTTP (upstream #611/#731)');
check(has('SIMULATE_TYPING=false'), 'the platform sends its own typing indicators; upstream\'s would stack a second delay');
check(has('AUTO_START_SESSIONS=true'), 'without this a reboot costs the masjid a re-link');
check(has('MAX_CONCURRENT_SESSIONS=1'), 'one masjid, one number — this is also the memory bound');

// ── report ──────────────────────────────────────────────────────────────────────
if (problems.length) {
  console.error(`✗ ${problems.length} problem(s):`);
  for (const p of problems) console.error(`   - ${p}`);
  process.exit(1);
}
console.log(`✓ package is consistent — ${image}, manifest ${manifest.version}`);
