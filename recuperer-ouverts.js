// Sources publiées sous Licence Ouverte : consultations en cours (flux XML) et marchés de travaux absents des DECP.
// Écrit annonces-ouvertes.json et marches-travaux.json. Une source en panne garde son fichier précédent. Aucun identifiant.
const fs = require('fs');
const path = require('path');

// N'ajouter ici qu'un flux dont la licence ouverte est vérifiée.
const FLUX = [{ id: 'pompey', nom: 'Bassin de Pompey', licence: 'Licence Ouverte 2.0', url: 'https://www.xmarches.fr/entreprise/listeConsultations_xml.php?UIDSPL=GC54006', plateforme: 'XMarchés', deps: ['54'] }];
const JEU_TRAVAUX = 'https://www.data.gouv.fr/api/1/datasets/marches-publics-de-travaux-connus-seulement-par-un-avis-dattribution-boamp-ou-ted-absents-des-decp/';

const decoder = (s) => String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const champ = (bloc, nom) => { const m = bloc.match(new RegExp('<' + nom + '>([\\s\\S]*?)</' + nom + '>')); return m ? decoder(m[1]) : ''; };
const dateIso = (s) => { const m = String(s).match(/^(\d{2})\/(\d{2})\/(\d{4})/); return m ? `${m[3]}-${m[2]}-${m[1]}` : ''; };

// Flux XML de consultations : seules celles encore ouvertes sont gardées.
function lireFlux(xml, flux, aujourdhui) {
  return [...String(xml).matchAll(/<marche_\d+>([\s\S]*?)<\/marche_\d+>/g)].map(([, b]) => ({
    id: flux.id + '-' + champ(b, 'ref'), ref: champ(b, 'ref'), objet: champ(b, 'titre'), acheteurNom: champ(b, 'personnepublique'), siret: champ(b, 'siret'), url: champ(b, 'url'),
    type: champ(b, 'typemarche'), secteur: champ(b, 'secteuractivite'), dateParution: dateIso(champ(b, 'datepubli')), dateLimite: dateIso(champ(b, 'datelim')),
    deps: flux.deps, sourceNom: flux.nom, plateforme: flux.plateforme
  })).filter((a) => a.objet && a.url && a.dateLimite >= aujourdhui);
}

// CSV avec champs entre guillemets (l'objet contient des virgules et des retours à la ligne).
function lireCsv(texte) {
  const lignes = []; let ligne = [], c = '', dedans = false;
  for (let i = 0; i < texte.length; i++) {
    const x = texte[i];
    if (dedans) { if (x === '"' && texte[i + 1] === '"') { c += '"'; i++; } else if (x === '"') dedans = false; else c += x; }
    else if (x === '"') dedans = true;
    else if (x === ',') { ligne.push(c); c = ''; }
    else if (x === '\n') { ligne.push(c.replace(/\r$/, '')); lignes.push(ligne); ligne = []; c = ''; }
    else c += x;
  }
  if (c || ligne.length) { ligne.push(c); lignes.push(ligne); }
  const [tete, ...reste] = lignes;
  return reste.map((l) => Object.fromEntries(tete.map((t, i) => [t, l[i] || ''])));
}

// Seul le SIREN des titulaires est repris, jamais leur nom. Sans titulaire identifié, la ligne n'apporte rien à l'outil.
function reduireTravaux(l) {
  const sirens = [...new Set(String(l.titulaires_siren).split('|').map((s) => s.trim()).filter((s) => /^\d{9}$/.test(s)))];
  const date = l.date_notification || l.date_publication;
  const acheteurId = l.acheteur_siret || l.acheteur_siren;
  if (!sirens.length || !acheteurId || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return { id: l.identifiant, acheteurId, acheteurNom: l.acheteur_nom, objet: String(l.titre_lot || l.objet || l.titre_avis).slice(0, 200), cpv: l.cpv, dep: /^\d{5}$/.test(l.lieu_code_postal) ? l.lieu_code_postal.slice(0, 2) : '',
    date, montant: Number(l.montant_ht) || null, sirens, url: l.url_avis };
}

const ecrire = (nom, contenu) => fs.writeFileSync(path.join(process.cwd(), nom), JSON.stringify(contenu));
async function texteDe(url) { const r = await fetch(url, { signal: AbortSignal.timeout(120000) }); if (!r.ok) throw new Error('réponse ' + r.status + ' de ' + url); return r.text(); }

async function principal() {
  const genere = new Date().toISOString().slice(0, 10);
  try {
    const annonces = (await Promise.all(FLUX.map(async (f) => lireFlux(await texteDe(f.url), f, genere)))).flat();
    ecrire('annonces-ouvertes.json', { genere, licence: 'Licence Ouverte 2.0', flux: FLUX.map((f) => f.nom), annonces });
    console.log(annonces.length + ' consultations ouvertes');
  } catch (e) { console.log('::warning::flux non mis à jour : ' + e.message); }
  try {
    const jeu = JSON.parse(await texteDe(JEU_TRAVAUX));
    const res = jeu.resources.find((r) => r.format === 'csv');
    if (jeu.license !== 'lov2' || !res) throw new Error('licence ou fichier inattendu');
    const marches = lireCsv(await texteDe(res.url)).map(reduireTravaux).filter(Boolean);
    if (!marches.length) throw new Error('fichier vide');
    ecrire('marches-travaux.json', { source: jeu.page, licence: 'Licence Ouverte 2.0', genere, marches });
    console.log(marches.length + ' marchés de travaux');
  } catch (e) { console.log('::warning::travaux non mis à jour : ' + e.message); }
}

if (require.main === module) principal();
module.exports = { FLUX, lireFlux, lireCsv, reduireTravaux };
