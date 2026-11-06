// Récupère les avis de marché français publiés sur TED et les écrit dans avis.json.
// Source : TED, Office des publications de l'Union européenne, réutilisation libre (CC BY 4.0).
// Aucune dépendance, aucun identifiant : l'API de recherche de TED est publique. Lancé chaque nuit par GitHub Actions.
const fs = require('fs');
const path = require('path');

const URL_API = 'https://api.ted.europa.eu/v3/notices/search';
// Tout le bâtiment : travaux, maintenance, installation, ingénierie et services aux bâtiments.
const PREFIXES = ['45', '50', '51', '71', '90'];
const JOURS = 60;
const TAILLE_PAGE = 250;
const MAX_PAGES = 40;
const CHAMPS = ['publication-number', 'notice-title', 'buyer-name', 'publication-date', 'deadline-receipt-tender-date-lot', 'classification-cpv',
  'place-of-performance-subdiv-proc', 'place-of-performance-subdiv-lot', 'place-of-performance-post-code-proc', 'place-of-performance-post-code-lot', 'organisation-post-code-buyer',
  'buyer-identifier', 'estimated-value-proc', 'framework-maximum-value-lot', 'document-url-lot', 'contract-nature-main-proc', 'framework-agreement-lot'];

const joursAvant = (iso, n) => new Date(new Date(iso + 'T12:00:00Z').getTime() - n * 864e5).toISOString().slice(0, 10);

function requete(prefixes, aujourdhui, jours) {
  const motifs = prefixes.map((p) => p + '*').join(' ');
  return `buyer-country=FRA AND notice-type=cn-standard AND publication-date>=${joursAvant(aujourdhui, jours).replace(/-/g, '')} AND classification-cpv IN (${motifs}) SORT BY publication-date DESC`;
}

// Encore ouvert : au moins une date limite à venir ; sans date connue, gardé (l'outil décide à la lecture).
function garder(n, aujourdhui) {
  const dates = [].concat(n['deadline-receipt-tender-date-lot'] || []).map((d) => String(d).slice(0, 10));
  return !dates.length || dates.some((d) => d >= aujourdhui);
}

// Fichier léger : le français seul (TED donne chaque titre dans toutes les langues de l'Union), sans valeur répétée.
function reduire(n) {
  const r = {};
  for (const [cle, v] of Object.entries(n)) {
    if (v === null || v === undefined || cle === 'links') continue;
    if (typeof v === 'object' && !Array.isArray(v)) r[cle] = v.fra !== undefined ? { fra: v.fra } : { [Object.keys(v)[0]]: Object.values(v)[0] };
    else r[cle] = Array.isArray(v) ? [...new Set(v)] : v;
  }
  return r;
}

const PAUSE_MS = 1500; // TED limite le rythme : une page toutes les 1,5 s
const ESSAIS = 6;
const dormir = (ms) => new Promise((ok) => setTimeout(ok, ms));

// Refus « trop de requêtes » : on attend le délai demandé par TED, sinon de plus en plus longtemps, puis on réessaie.
async function appeler(fetch, corps, pause) {
  for (let essai = 1; ; essai++) {
    const r = await fetch(URL_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: corps });
    if (r.status !== 429 || essai === ESSAIS) return r;
    const demande = Number(r.headers && r.headers.get && r.headers.get('retry-after'));
    await pause(demande > 0 ? demande * 1000 : essai * 15000);
  }
}

async function recuperer(fetch, { prefixes, aujourdhui, jours, pause = dormir }) {
  const q = requete(prefixes, aujourdhui, jours);
  const avis = new Map();
  let tronque = false;
  for (let page = 1; page <= MAX_PAGES; page++) {
    if (page > 1) await pause(PAUSE_MS);
    const r = await appeler(fetch, JSON.stringify({ query: q, fields: CHAMPS, limit: TAILLE_PAGE, page }), pause);
    if (!r.ok) throw new Error('TED a répondu ' + r.status);
    const notices = (await r.json()).notices || [];
    for (const n of notices) if (n['publication-number']) avis.set(String(n['publication-number']), n);
    if (notices.length < TAILLE_PAGE) break;
    if (page === MAX_PAGES) tronque = true;
  }
  return { notices: [...avis.values()].filter((n) => garder(n, aujourdhui)).map(reduire), tronque };
}

async function principal() {
  const aujourdhui = new Date().toISOString().slice(0, 10);
  const { notices, tronque } = await recuperer(fetch, { prefixes: PREFIXES, aujourdhui, jours: JOURS });
  // Une réponse vide est une panne, pas une journée sans marché : on garde le fichier précédent.
  if (!notices.length) throw new Error('TED n’a renvoyé aucun avis');
  const contenu = { source: 'TED, Office des publications de l’Union européenne (CC BY 4.0)', jour: aujourdhui, majLe: new Date().toISOString(), tronque, notices };
  fs.writeFileSync(process.argv[2] || path.join(__dirname, 'avis.json'), JSON.stringify(contenu));
  console.log(notices.length + ' avis écrits' + (tronque ? ' (liste tronquée)' : ''));
}

if (require.main === module) principal().catch((e) => { console.error(e.message); process.exit(1); });
module.exports = { requete, recuperer, garder, reduire, PREFIXES };
