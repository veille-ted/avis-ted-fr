// Récupère les marchés attribués publiés en données ouvertes par AJI et écrit marches-aji.json.
// Bâtiment seulement. Aucun nom de titulaire : seulement le SIREN. Aucune dépendance, aucun identifiant.
const fs = require('fs');
const path = require('path');

const URL_DONNEES = 'https://mapa.aji-france.com/mapa/marche/opendata';
const PREFIXES = ['45', '50', '51', '71', '90'];

function garderMarche(m, aujourdhui) {
  const date = String(m.dateNotification || '');
  return PREFIXES.some((p) => String(m.codeCPV || '').startsWith(p)) && date >= '2000-01-01' && date <= aujourdhui && !!(m.acheteurs && m.acheteurs[0] && m.acheteurs[0].id);
}

function reduire(m) {
  const lieu = m.lieuExecution || {};
  return { id: String(m.id || ''), acheteurId: String(m.acheteurs[0].id), acheteurNom: String(m.acheteurs[0].nom || ''), objet: String(m.objet || ''), cpv: String(m.codeCPV || '').split('-')[0],
    dep: /d[ée]partement/i.test(String(lieu.typeCode || '')) ? String(lieu.code || '') : '', procedure: String(m.procedure || ''), dureeMois: Number(m.dureeMois) || null,
    date: String(m.dateNotification), montant: Number(m.montant) || null,
    sirens: [...new Set((m.titulaires || []).filter((t) => t.typeIdentifiant === 'SIRET' && /^\d{14}$/.test(String(t.id))).map((t) => String(t.id).slice(0, 9)))] };
}

async function principal() {
  const aujourdhui = new Date().toISOString().slice(0, 10);
  const r = await fetch(URL_DONNEES, { signal: AbortSignal.timeout(120000) });
  if (!r.ok) throw new Error('AJI a répondu ' + r.status);
  const donnees = await r.json();
  if (!Array.isArray(donnees) || !donnees.length) throw new Error('données AJI vides ou illisibles : fichier précédent conservé');
  const marches = donnees.filter((m) => garderMarche(m, aujourdhui)).map(reduire);
  if (!marches.length) throw new Error('aucun marché du bâtiment : fichier précédent conservé');
  fs.writeFileSync(path.join(process.cwd(), 'marches-aji.json'), JSON.stringify({ source: URL_DONNEES, genere: aujourdhui, marches }));
  console.log(marches.length + ' marchés écrits');
}

if (require.main === module) principal().catch((e) => { console.error(e.message); process.exit(1); });
module.exports = { garderMarche, reduire, PREFIXES };
