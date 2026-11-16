// Récupère les avis de marché français publiés sur TED et les écrit dans avis.json.
// Source : TED, Office des publications de l'Union européenne, réutilisation libre (CC BY 4.0).
// Aucune dépendance, aucun identifiant : l'API de recherche de TED est publique. Lancé chaque nuit par GitHub Actions.
const fs = require('fs');
const path = require('path');

const URL_API = 'https://api.ted.europa.eu/v3/notices/search';
// Depuis le 16/11/2026 : plus aucun filtre de code CPV (un avis de climatisation classé en équipements, de chauffage urbain… était perdu) ;
// l'outil trie ensuite par métier. PREFIXES reste pour la compatibilité, vide = tous les codes.
const PREFIXES = [];
const JOURS = 90; // avis sans date limite : gardés s'ils ont paru depuis 90 jours
const TAILLE_PAGE = 250;
const MAX_PAGES = 100; // 25 000 avis au plus ; au-delà, le fichier est marqué « tronqué »
// Tous les avis qui appellent à la concurrence, pas seulement les avis de marché standard : concours (maîtrise d'œuvre),
// services sociaux et spécifiques, pré-informations valant appel à la concurrence, systèmes de qualification, sous-traitance
const TYPES = ['cn-standard', 'cn-social', 'cn-desg', 'pin-cfc-standard', 'pin-cfc-social', 'qu-sy', 'subco'];
const CHAMPS = ['publication-number', 'procedure-identifier', 'notice-type', 'notice-title', 'buyer-name', 'publication-date', 'deadline-receipt-tender-date-lot', 'deadline-receipt-request-date-lot', 'classification-cpv',
  'place-of-performance-subdiv-proc', 'place-of-performance-subdiv-lot', 'place-of-performance-post-code-proc', 'place-of-performance-post-code-lot', 'organisation-post-code-buyer',
  'buyer-identifier', 'estimated-value-proc', 'framework-maximum-value-lot', 'document-url-lot', 'contract-nature-main-proc', 'framework-agreement-lot'];

const joursAvant = (iso, n) => new Date(new Date(iso + 'T12:00:00Z').getTime() - n * 864e5).toISOString().slice(0, 10);

// Acheteurs français, ou travaux en France d'un acheteur étranger ; encore ouverts (remise des offres ou des candidatures à venir),
// ou parus depuis « jours » jours (avis sans date limite : garder() tranche ensuite)
function requete(prefixes, aujourdhui, jours) {
  const t = aujourdhui.replace(/-/g, '');
  const cpv = prefixes.length ? ` AND classification-cpv IN (${prefixes.map((p) => p + '*').join(' ')})` : '';
  return `(buyer-country=FRA OR place-of-performance=FRA) AND notice-type IN (${TYPES.join(' ')})${cpv}`
    + ` AND (deadline-receipt-tender-date-lot>=${t} OR deadline-receipt-request-date-lot>=${t} OR publication-date>=${joursAvant(aujourdhui, jours).replace(/-/g, '')})`;
}

// Encore ouvert : une date limite de remise des offres à venir ; sinon une date limite des candidatures à venir ;
// sans aucune date, gardé (l'outil décide à la lecture, d'après la date de parution).
function garder(n, aujourdhui) {
  const dates = (cle) => [].concat(n[cle] || []).map((d) => String(d).slice(0, 10));
  const offres = dates('deadline-receipt-tender-date-lot'), candidatures = dates('deadline-receipt-request-date-lot');
  if (offres.some((d) => d >= aujourdhui) || candidatures.some((d) => d >= aujourdhui)) return true;
  return !offres.length && !candidatures.length;
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
    // trop de requêtes, ou serveur momentanément indisponible : on réessaie
    if (![429, 502, 503, 504].includes(r.status) || essai === ESSAIS) return r;
    const demande = Number(r.headers && r.headers.get && r.headers.get('retry-after'));
    await pause(demande > 0 ? demande * 1000 : essai * 15000);
  }
}

async function recuperer(fetch, { prefixes, aujourdhui, jours, pause = dormir }) {
  const q = requete(prefixes, aujourdhui, jours);
  const avis = new Map();
  let tronque = false;
  // Lecture par itération (jeton de reprise) : parcours stable. La lecture par numéro de page, triée sur une date que des centaines
  // d'avis partagent, en lisait ~200 deux fois et en sautait autant (mesuré le 16/11/2026 : 215 sur 14 675).
  let jeton = null;
  for (let tour = 1; ; tour++) {
    if (tour > MAX_PAGES) { tronque = true; break; }
    if (tour > 1) await pause(PAUSE_MS);
    const corps = { query: q, fields: CHAMPS, limit: TAILLE_PAGE, paginationMode: 'ITERATION' };
    if (jeton) corps.iterationNextToken = jeton;
    const r = await appeler(fetch, JSON.stringify(corps), pause);
    if (!r.ok) throw new Error('TED a répondu ' + r.status);
    const reponse = await r.json();
    const notices = reponse.notices || [];
    for (const n of notices) if (n['publication-number']) avis.set(String(n['publication-number']), n);
    jeton = reponse.iterationNextToken;
    if (!notices.length || !jeton) break;
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
module.exports = { requete, recuperer, garder, reduire, PREFIXES, TYPES };
