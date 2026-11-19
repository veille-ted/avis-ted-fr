// Contrôle de la nuit : les sources des appels d'offres répondent-elles complètement ? (rien n'est modifié, aucune donnée d'équipe)
// Écrit controle.json, lu par l'outil : un écart s'y affiche en avertissement au-dessus des appels d'offres.
// node controler-sources.js [fichier de sortie]
const fs = require('node:fs');
const path = require('node:path');

const BOAMP = 'https://boamp-datadila.opendatasoft.com/api/explore/v2.1/catalog/datasets/boamp/';
const DECP = 'https://data.economie.gouv.fr/api/explore/v2.1/catalog/datasets/decp-2022-marches-valides';
const VOLUME_MIN_BOAMP = 2000; // avis de marché ouverts en France (travaux et services) : environ 5 400 en novembre 2026
const AVIS_MIN_TED = 1000;
const jours = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
const json = async (f, url) => { const r = await f(url, { signal: AbortSignal.timeout(60000) }); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); };

async function verifier(f, aujourdhui, lireTed) {
  const ouverts = `nature_libelle="Avis de marché" and datelimitereponse >= date'${aujourdhui}' and (type_marche="TRAVAUX" or type_marche="SERVICES")`;
  const etapes = [
    ['BOAMP', 'à jour', async () => {
      const d = String(((await json(f, BOAMP + 'records?select=max(dateparution)%20as%20d&limit=1')).results[0] || {}).d || '').slice(0, 10);
      return [d && jours(d, aujourdhui) <= 4, 'dernière parution du ' + (d || 'inconnue')];
    }],
    ['BOAMP', 'volume', async () => {
      const n = (await json(f, BOAMP + 'records?limit=0&where=' + encodeURIComponent(ouverts))).total_count;
      return [n >= VOLUME_MIN_BOAMP, n + ' avis de marché ouverts en France'];
    }],
    ['BOAMP', 'export complet', async () => {
      const where = ouverts.replace('(type_marche="TRAVAUX" or type_marche="SERVICES")', 'type_marche="TRAVAUX"');
      const [total, lignes] = await Promise.all([json(f, BOAMP + 'records?limit=0&where=' + encodeURIComponent(where)).then((j) => j.total_count),
        json(f, BOAMP + 'exports/json?select=idweb&where=' + encodeURIComponent(where)).then((l) => l.length)]);
      return [lignes === total, lignes + ' reçus sur ' + total + ' annoncés'];
    }],
    ['TED', 'fichier du jour', async () => {
      const v = lireTed();
      const n = Array.isArray(v.notices) ? v.notices.length : 0;
      return [v.jour === aujourdhui && n >= AVIS_MIN_TED && v.tronque !== true, n + ' avis, fichier du ' + (v.jour || 'inconnu') + (v.tronque === true ? ', tronqué' : '')];
    }],
    ['DECP', 'à jour', async () => {
      const d = String((((await json(f, DECP)).metas || {}).default || {}).data_processed || '').slice(0, 10);
      return [d && jours(d, aujourdhui) <= 15, 'mise à jour du ' + (d || 'inconnue')];
    }]
  ];
  const verifications = [];
  for (const [source, nom, faire] of etapes) {
    try { const [ok, detail] = await faire(); verifications.push({ source, nom, ok: !!ok, detail }); }
    catch (e) { verifications.push({ source, nom, ok: false, detail: 'ne répond pas (' + e.message + ')' }); }
  }
  return verifications;
}

async function principal() {
  const aujourdhui = new Date().toISOString().slice(0, 10);
  const lireTed = () => JSON.parse(fs.readFileSync(path.join(__dirname, 'avis.json'), 'utf8'));
  const verifications = await verifier(fetch, aujourdhui, lireTed);
  fs.writeFileSync(process.argv[2] || path.join(__dirname, 'controle.json'), JSON.stringify({ jour: aujourdhui, majLe: new Date().toISOString(), verifications }, null, 1));
  for (const v of verifications) console.log((v.ok ? 'ok    ' : 'ÉCART ') + v.source + ' · ' + v.nom + ' : ' + v.detail);
}

if (require.main === module) principal().catch((e) => { console.error(e.message); process.exit(1); });
module.exports = { verifier };
