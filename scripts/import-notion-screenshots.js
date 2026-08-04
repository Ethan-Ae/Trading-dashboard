#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Import des screenshots d'un export Notion (HTML) vers les trades OneR Trade.
//
// ⚠️ Ce script n'EFFACE JAMAIS de données : il ne fait qu'AJOUTER des images
//    aux tableaux existants de la colonne `screenshots` (append idempotent).
//
// Format de stockage OneR (vérifié dans index.html) :
//   - table `trades`, colonne `screenshots` (jsonb)
//   - PAS de bucket Storage : les images sont des data URLs base64 INLINE
//   - clés / catégories : { exec:[], mgmt:[], close:[], after:[] }  (tableaux)
//
// Mapping titres de section Notion → clé OneR :
//   "SCREENSHOT D'EXÉCUTION"        → exec   (📸 Exécution)
//   "SCREENSHOT DE TRADE MANAGEMENT"→ mgmt   (🔄 Management)
//   "SCREENSHOT DE CLÔTURE"         → close  (🏁 Clôture)
//   "SCREENSHOT SUITE A LA CLÔTURE" → after  (📈 Après position)
//
// Usage :
//   node scripts/import-notion-screenshots.js --dry-run
//   node scripts/import-notion-screenshots.js
//
// Variables d'environnement requises :
//   SUPABASE_SERVICE_ROLE_KEY   (obligatoire, ne jamais commit)
//   SUPABASE_USER_ID  OU  SUPABASE_USER_EMAIL   (pour cibler TON compte)
// Optionnel :
//   SUPABASE_URL       (défaut : projet OneR ci-dessous)
//   NOTION_EXPORT_DIR  (défaut : ./notion-export)
// ─────────────────────────────────────────────────────────────────────────────

import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// ─── Arguments CLI ───────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const hasFlag = (f) => args.includes(f);
const getOpt  = (name) => {
  const p = args.find((a) => a.startsWith(`--${name}=`));
  return p ? p.slice(name.length + 3) : undefined;
};
const DRY_RUN = hasFlag('--dry-run');

// ─── Config ──────────────────────────────────────────────────────────────────
const SB_URL = process.env.SUPABASE_URL || 'https://zftmwtiahywqqqnlzxue.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const USER_ID_ENV = getOpt('user-id') || process.env.SUPABASE_USER_ID;
const USER_EMAIL_ENV = getOpt('email') || process.env.SUPABASE_USER_EMAIL;
const EXPORT_DIR = path.resolve(
  REPO_ROOT,
  getOpt('root') || process.env.NOTION_EXPORT_DIR || 'notion-export'
);

// Client Supabase — créé paresseusement dans main() (après validation de l'env),
// pour que l'import du module (tests, --help) ne nécessite pas de clé.
let sb;

// ─── Helpers ─────────────────────────────────────────────────────────────────
const MIME_BY_EXT = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
};

function decodeEntities(s) {
  return String(s)
    .replace(/&#x27;/gi, "'").replace(/&#39;/g, "'")
    .replace(/&quot;/gi, '"').replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&nbsp;/gi, ' ');
}

// Normalise une paire pour le matching : majuscules, sans accents ni séparateurs.
function normPair(s) {
  return decodeEntities(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// Normalise un libellé de section (majuscules, sans accents) pour le matching.
function normText(s) {
  return decodeEntities(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase();
}

// "17/12/2025" → "2025-12-17" ; passe-plat si déjà en ISO.
function frToIso(d) {
  if (!d) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(d.trim());
  if (!m) return null;
  return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

// Toutes les catégories OneR gérées, dans l'ordre d'affichage du rapport.
const CATS = ['confluences', 'exec', 'mgmt', 'close', 'after'];
const KEY_LABEL = {
  confluences: '🖼️ Raisons', exec: '📸 Exécution', mgmt: '🔄 Management',
  close: '🏁 Clôture', after: '📈 Après position',
};

// Titre de section → clé OneR. L'ordre compte : "SUITE ... CLÔTURE" avant "CLÔTURE".
function sectionKey(titleRaw) {
  const t = normText(titleRaw);
  if (t.includes('RAISONS') || t.includes('CONFLUENCES')) return 'confluences';
  if (!t.includes('SCREENSHOT')) return null;
  if (t.includes('SUITE')) return 'after';           // SUITE A LA CLOTURE
  if (t.includes('MANAGEMENT')) return 'mgmt';
  if (t.includes('CLOTURE')) return 'close';
  if (t.includes('EXECUTION')) return 'exec';
  return null;
}

// Récupère récursivement tous les .html sous un dossier.
function walkHtml(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkHtml(full, out);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.html')) out.push(full);
  }
  return out;
}

// ─── Parsing d'une page Notion ───────────────────────────────────────────────
function parsePage(file) {
  const html = fs.readFileSync(file, 'utf8');
  const dir = path.dirname(file);

  // Paire : <h1 class="page-title">…</h1> (fallback <title>)
  let pairRaw = (/<h1[^>]*class="[^"]*page-title[^"]*"[^>]*>([\s\S]*?)<\/h1>/i.exec(html) || [])[1]
             || (/<title>([\s\S]*?)<\/title>/i.exec(html) || [])[1] || '';
  pairRaw = decodeEntities(pairRaw.replace(/<[^>]+>/g, '')).trim();

  // Date : <time datetime="YYYY-MM-DD"> (fallback property-row-date en DD/MM/YYYY)
  let iso = (/<time[^>]*datetime="(\d{4}-\d{2}-\d{2})"/i.exec(html) || [])[1] || null;
  if (!iso) {
    const dm = /property-row-date[\s\S]*?<td>([\s\S]*?)<\/td>/i.exec(html);
    if (dm) {
      const txt = decodeEntities(dm[1].replace(/<[^>]+>/g, '')).trim();
      iso = frToIso(txt);
    }
  }

  // Parcours en ordre du document : sections + images locales.
  // Une image locale = src qui ne commence pas par http(s).
  const scan = /((?:SCREENSHOT|RAISONS)[^:<]*)|<img\b[^>]*?\bsrc="(?!https?:\/\/)([^"]+)"/gi;
  const images = { confluences: [], exec: [], mgmt: [], close: [], after: [] };
  let currentKey = null;
  let orphanImages = 0;
  let m;
  while ((m = scan.exec(html)) !== null) {
    if (m[1] !== undefined) {
      const k = sectionKey(m[1]);
      if (k) currentKey = k;
      continue;
    }
    // m[2] = src relatif éventuellement URL-encodé
    let rel;
    try { rel = decodeURIComponent(m[2]); } catch { rel = m[2]; }
    const abs = path.resolve(dir, rel);
    if (!currentKey) { orphanImages++; continue; }
    images[currentKey].push(abs);
  }

  return { file, pair: pairRaw, date: iso, images, orphanImages };
}

// Lit une image disque → data URL base64 (format EXACT attendu par OneR).
function fileToDataUrl(abs) {
  const ext = path.extname(abs).toLowerCase();
  const mime = MIME_BY_EXT[ext] || 'image/png';
  const b64 = fs.readFileSync(abs).toString('base64');
  return `data:${mime};base64,${b64}`;
}

// ─── Résolution du user_id ───────────────────────────────────────────────────
async function resolveUserId() {
  if (USER_ID_ENV) return USER_ID_ENV;
  // Recherche par email via l'API admin (pagination).
  const target = USER_EMAIL_ENV.trim().toLowerCase();
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`listUsers: ${error.message}`);
    const hit = (data?.users || []).find((u) => (u.email || '').toLowerCase() === target);
    if (hit) return hit.id;
    if (!data || data.users.length < 200) break;
  }
  throw new Error(`Aucun compte Auth trouvé pour l'email ${USER_EMAIL_ENV}`);
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  if (!SERVICE_KEY) {
    console.error('❌ SUPABASE_SERVICE_ROLE_KEY manquante. Exporte-la avant de lancer le script.');
    process.exit(1);
  }
  if (!USER_ID_ENV && !USER_EMAIL_ENV) {
    console.error('❌ Cible manquante : exporte SUPABASE_USER_ID ou SUPABASE_USER_EMAIL.');
    process.exit(1);
  }
  // La service_role bypasse la RLS → on FILTRE nous-mêmes par user_id (sécurité).
  sb = createClient(SB_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

  console.log(`\n🗂️  OneR Trade — Import screenshots Notion ${DRY_RUN ? '(DRY-RUN, aucune écriture)' : '(ÉCRITURE RÉELLE)'}`);
  console.log(`   Export : ${EXPORT_DIR}`);
  console.log(`   Supabase : ${SB_URL}\n`);

  if (!fs.existsSync(EXPORT_DIR)) {
    console.error(`❌ Dossier introuvable : ${EXPORT_DIR}`);
    process.exit(1);
  }

  const userId = await resolveUserId();
  console.log(`👤 user_id ciblé : ${userId}\n`);

  // 1) Parse toutes les pages Notion (récursif).
  const imgCount = (imgs) => CATS.reduce((s, k) => s + imgs[k].length, 0);
  const files = walkHtml(EXPORT_DIR);
  const pages = files.map(parsePage);
  const pagesWithImages = pages.filter((p) => imgCount(p.images) > 0);
  console.log(`📄 ${files.length} pages HTML scannées — ${pagesWithImages.length} avec au moins une image.\n`);

  // 2) Charge les trades de MON compte.
  const { data: trades, error } = await sb
    .from('trades')
    .select('id, pair, date, screenshots, extra_data')
    .eq('user_id', userId);
  if (error) { console.error('❌ SELECT trades :', error.message); process.exit(1); }
  console.log(`📊 ${trades.length} trades chargés pour ce compte.\n`);

  // 3) Index de matching : (pairNormalisée | dateISO) → [trades].
  //    Dates candidates = date de création + date de prise de position (extra_data).
  const index = new Map();
  const addIdx = (pair, iso, t) => {
    if (!pair || !iso) return;
    const key = `${pair}|${iso}`;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(t);
  };
  for (const t of trades) {
    const np = normPair(t.pair);
    addIdx(np, frToIso(t.date), t);
    const entry = t.extra_data && t.extra_data['Date Prise de Position'];
    if (entry) addIdx(np, frToIso(entry), t);
  }

  // 4) Match + construction des mises à jour.
  const totals = Object.fromEntries(CATS.map((k) => [k, 0]));
  const unmatched = [];
  const ambiguous = [];
  const skippedNoMeta = [];
  const missingFiles = [];
  const updates = new Map(); // tradeId → { trade, screenshots }
  let matchedPages = 0;

  for (const p of pagesWithImages) {
    if (!p.pair || !p.date) { skippedNoMeta.push(p); continue; }
    const key = `${normPair(p.pair)}|${p.date}`;
    const cand = index.get(key) || [];
    // dédoublonne (une même page peut matcher via date création ET prise de position)
    const uniq = [...new Set(cand)];
    if (uniq.length === 0) { unmatched.push(p); continue; }
    if (uniq.length > 1) { ambiguous.push({ page: p, count: uniq.length }); continue; }

    const trade = uniq[0];
    matchedPages++;

    // État courant (accumulé si plusieurs pages → même trade).
    let acc = updates.get(trade.id);
    if (!acc) {
      const base = { ...(trade.screenshots || {}) };
      for (const k of CATS) {
        if (!Array.isArray(base[k])) base[k] = base[k] ? [base[k]] : [];
      }
      acc = { trade, screenshots: base };
      updates.set(trade.id, acc);
    }

    for (const k of CATS) {
      for (const abs of p.images[k]) {
        if (!fs.existsSync(abs)) { missingFiles.push(abs); continue; }
        const dataUrl = fileToDataUrl(abs);
        if (acc.screenshots[k].includes(dataUrl)) continue; // idempotent : déjà importée
        acc.screenshots[k].push(dataUrl);
        totals[k]++;
      }
    }
  }

  // 5) Écriture (sauf dry-run). On ne touche QUE la colonne screenshots.
  let written = 0;
  if (!DRY_RUN) {
    for (const { trade, screenshots } of updates.values()) {
      const { error: upErr } = await sb
        .from('trades')
        .update({ screenshots })
        .eq('id', trade.id)
        .eq('user_id', userId);
      if (upErr) { console.error(`❌ update trade ${trade.id} (${trade.pair}) :`, upErr.message); continue; }
      written++;
    }
  }

  // 6) Rapport.
  console.log('──────────────────────────────────────────────');
  console.log('RÉSUMÉ');
  console.log('──────────────────────────────────────────────');
  console.log(`Pages avec images        : ${pagesWithImages.length}`);
  console.log(`Pages matchées à un trade: ${matchedPages}`);
  console.log(`Trades ${DRY_RUN ? 'à mettre à jour' : 'mis à jour'}        : ${DRY_RUN ? updates.size : written}`);
  console.log('');
  console.log('Images par catégorie :');
  for (const k of CATS) {
    console.log(`  ${KEY_LABEL[k].padEnd(18)} : ${totals[k]}`);
  }
  const totalImgs = CATS.reduce((s, k) => s + totals[k], 0);
  console.log(`  ${'TOTAL'.padEnd(18)} : ${totalImgs}`);

  if (ambiguous.length) {
    console.log(`\n⚠️  ${ambiguous.length} page(s) AMBIGUË(S) — plusieurs trades même paire+date (ignorées, aucune modif) :`);
    for (const { page, count } of ambiguous)
      console.log(`  • ${page.pair} ${page.date} (${count} trades)  ← ${path.relative(REPO_ROOT, page.file)}`);
  }

  if (skippedNoMeta.length) {
    console.log(`\n⚠️  ${skippedNoMeta.length} page(s) sans paire ou sans date (non traitées) :`);
    for (const p of skippedNoMeta)
      console.log(`  • pair="${p.pair||'?'}" date="${p.date||'?'}"  ← ${path.relative(REPO_ROOT, p.file)}`);
  }

  if (missingFiles.length) {
    console.log(`\n⚠️  ${missingFiles.length} image(s) référencée(s) mais absente(s) du disque (ignorées).`);
  }

  if (unmatched.length) {
    console.log(`\n❌ ${unmatched.length} page(s) Notion SANS correspondance (paire+date introuvable dans tes trades) :`);
    for (const p of unmatched) {
      const n = imgCount(p.images);
      console.log(`  • ${p.pair} ${p.date}  (${n} image${n>1?'s':''})  ← ${path.relative(REPO_ROOT, p.file)}`);
    }
  }

  console.log('\n' + (DRY_RUN
    ? '✅ DRY-RUN terminé. Aucune donnée modifiée. Relance sans --dry-run pour importer.'
    : `✅ Import terminé. ${written} trade(s) mis à jour, ${totalImgs} image(s) ajoutée(s).`) + '\n');
}

// N'exécute main() que si le script est lancé directement (pas à l'import/test).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('\n💥 Erreur fatale :', e); process.exit(1); });
}

export { parsePage, walkHtml, normPair, frToIso, sectionKey };
