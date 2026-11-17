import { afterEach, describe, expect, it } from 'vitest';
import type { Client, Reponse } from '../fixtures/comptes.js';
import { attaquerFlux } from './flux.js';
import { sonderFlux } from '../fixtures/flux-sse.js';
import { avecRequete, poserDansCorps } from './forge.js';
import { monde, type Monde } from './monde.js';
import { cle, INTROUVABLE, REGISTRE, type EntreeRoute } from './registre.js';

// SUITE GÉNÉRIQUE DE CLOISONNEMENT (architecture §8, ADR-0002 : « pour chaque route, un test »). Écrite une fois, elle
// s'applique à CHAQUE entrée du registre : ajouter une route au registre lui donne ses attaques sans écrire un test.
//
// Le décor : deux groupes, A (Alice) et B (Bob), un exemplaire de chaque ressource dans chacun (monde.ts). Alice est
// l'attaquante ; elle n'a aucun lien avec B. Pour chaque route, selon ce qu'elle exige :
//   1. sans session                                        → 401
//   2. GROUPE forgé : l'identifiant du groupe B, ressource de B → 404 `groupe.introuvable` (jamais 403), et rien n'est écrit
//   3. IDENTIFIANT forgé : son groupe A, la ressource de B  → 404 de la ressource, et rien n'est écrit. Forgé là où la route le
//      LIT : dans l'URL, dans le CORPS (`ressourcesCorps`) et dans la chaîne de REQUÊTE (`ressourcesRequete`). Deux attaquantes :
//      Alice (étrangère à B) et Manon (membre de A ET de B : un contrôle « a-t-elle accès au groupe de la ressource ? » la laisserait passer)
//   4. DROIT manquant (routes admin : `droit.admin_requis` ; routes `organisateur` : `droit.organisateur_requis`) : une simple membre
//      de A, ni auteure ni co-organisatrice de l'événement → 403, et rien n'est écrit — jamais confondu avec le 404.
//      Et à l'inverse, une route déclarée `appartenance` ne doit pas refuser (403) une simple membre : sinon elle est SOUS-DÉCLARÉE
//      (elle exige en réalité l'admin) et le registre mentirait sur ce qu'elle protège
//   5. sa propre route, ses propres identifiants           → ni 401, ni 403, ni 404, ni 5xx, et AUCUNE trace de B dans la réponse
//   (flux de calendrier, exigence `jetonFlux` : jeton inconnu, révoqué, membre retiré, jeton restreint — voir flux.ts)
//   6. ANCIEN membre : Alice retirée de A, ses propres identifiants → 404, alors que son historique est intact
// Un 404 n'est accepté que s'il porte la clé attendue : une route mal écrite répondrait `route.introuvable` et ne prouverait rien.

const ENTETE_PUBLIC = 'aucune' as const;

/** Photographie de la base entière (hors sessions, photographiées par état de révocation) : « rien n'a été écrit » se compare. */
function instantane(m: Monde): string {
  const tables = m.d.sql.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'sessions' ORDER BY name").pluck().all() as string[];
  const contenu = tables.map((t) => [t, m.d.sql.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()]);
  const sessions = m.d.sql.prepare('SELECT id, user_id, revoked_at FROM sessions ORDER BY id').all();
  return JSON.stringify({ contenu, sessions });
}

/** Les identifiants d'une requête, par endroit où la route les lit. */
type Identifiants = {
  readonly groupId: string;
  readonly ressources: Readonly<Record<string, string>>; // paramètres d'URL
  readonly corps: Readonly<Record<string, string>>; // chemins JSON
  readonly requete: Readonly<Record<string, string>>; // chaîne de requête
};

type Endroit = 'ressources' | 'corps' | 'requete';
const ENDROITS: ReadonlyArray<readonly [Endroit, 'ressources' | 'ressourcesCorps' | 'ressourcesRequete', string]> = [
  ['ressources', 'ressources', 'identifiant forgé'],
  ['corps', 'ressourcesCorps', 'identifiant forgé dans le corps'],
  ['requete', 'ressourcesRequete', 'identifiant forgé dans la requête'],
];

/** Chemin concret : `:groupId` et chaque paramètre déclaré sont remplacés (jamais deviné), puis la chaîne de requête. */
function url(e: EntreeRoute, ids: Identifiants): string {
  const chemin = e.chemin.replace(/:(\w+)/g, (_motif, nom: string) => encodeURIComponent(nom === 'groupId' ? ids.groupId : (ids.ressources[nom] ?? `:${nom}`)));
  return avecRequete(chemin, { ...e.requete, ...ids.requete });
}

function corpsDe(e: EntreeRoute, ids: Identifiants): unknown {
  return Object.entries(ids.corps).reduce<unknown>((corps, [chemin, id]) => poserDansCorps(corps, chemin, id), e.corps);
}

function appeler(c: Client, e: EntreeRoute, ids: Identifiants, options?: Parameters<Client['envoyer']>[3]): Promise<Reponse> {
  // Route à réponse ininterrompue (flux SSE) : un vrai socket, coupé après le premier message (sinon la suite attendrait sans fin).
  if (e.flux === true) return sonderFlux(c.app, c, url(e, ids));
  const methode = e.methode.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete';
  return c.envoyer(methode, url(e, ids), corpsDe(e, ids) ?? (methode === 'get' || methode === 'delete' ? undefined : {}), options);
}

function ressourcesDe(e: EntreeRoute, m: Monde, cote: 'a' | 'b'): Pick<Identifiants, 'ressources' | 'corps' | 'requete'> {
  const de = (declarees: EntreeRoute['ressources']): Record<string, string> =>
    Object.fromEntries(Object.entries(declarees ?? {}).map(([cle, nature]) => [cle, m.ressources[cote][nature]]));
  return { ressources: de(e.ressources), corps: de(e.ressourcesCorps), requete: de(e.ressourcesRequete) };
}

describe('suite générique de cloisonnement : une attaque par route du registre', () => {
  let m: Monde | undefined;
  afterEach(() => {
    m?.d.nettoyer();
    m = undefined;
  });

  const monter = async (): Promise<Monde> => {
    m = await monde();
    return m;
  };

  it.each(REGISTRE.map((e) => [cle(e), e] as const))('%s', { timeout: 30_000 }, async (_nom, e) => {
    const w = await monter();
    const idsA: Identifiants = { groupId: w.a.groupId, ...ressourcesDe(e, w, 'a') };
    const idsB: Identifiants = { groupId: w.b.groupId, ...ressourcesDe(e, w, 'b') };
    const anonyme = w.d.client('203.0.113.200');

    // Route publique : rien à cloisonner, mais le registre ne ment pas — elle ne réclame pas de session.
    if (e.exige === ENTETE_PUBLIC) {
      const r = await appeler(anonyme, e, idsA);
      expect(r.statut, `${cle(e)} déclarée publique`).not.toBe(401);
      expect(r.statut).toBeLessThan(500);
      return;
    }

    // Flux de calendrier : pas de cookie, donc pas de « 401 » ni de groupe dans l'URL — ses attaques sont les siennes (flux.ts).
    if (e.exige === 'jetonFlux') {
      await attaquerFlux(w, e);
      return;
    }

    // Relai média signé : exige une session ET une signature HMAC liée à l'utilisateur + albumId + assetId.
    if (e.exige === 'media') {
      const photosA = await w.alice.client.get(`/api/groupes/${w.a.groupId}/albums/${w.ressources.a.album}/photos`);
      expect(photosA.statut).toBe(200);
      const urlAlice = (photosA.corps['photos'] as Array<{ thumbnail_url: string }>)[0]?.thumbnail_url;
      expect(urlAlice).toBeTypeOf('string');
      if (urlAlice === undefined) throw new Error('URL signée absente.');

      // 1. Sans session → 401
      const sansMedia = await anonyme.get(urlAlice);
      expect(sansMedia.statut).toBe(401);
      expect(sansMedia.corps).toEqual({ error: 'session.requise' });

      // 2. Rejeu de l'URL d'Alice par Manon (ou Bob) → 403 media.signature_invalide
      const rejeuManon = await w.manon.client.get(urlAlice);
      expect(rejeuManon.statut).toBe(403);
      expect(rejeuManon.corps).toEqual({ error: 'media.signature_invalide' });

      // 3. Accès légitime d'Alice → 200
      const legitime = await w.alice.client.get(urlAlice);
      expect(legitime.statut).toBe(200);

      // 4. Retrait d'Alice de A → même avec sa propre URL signée valide, elle obtient 404 media.introuvable
      w.d.sql.prepare("UPDATE memberships SET status = 'removed', ended_at = ? WHERE group_id = ? AND user_id = ?").run('2026-11-16T00:00:00Z', w.a.groupId, w.alice.userId);
      const apresRetrait = await w.alice.client.get(urlAlice);
      expect(apresRetrait.statut).toBe(404);
      expect(apresRetrait.corps).toEqual({ error: 'media.introuvable' });
      return;
    }

    // 1. Sans session.
    const sans = await appeler(anonyme, e, idsA);
    expect(sans.statut, 'sans session').toBe(401);
    expect(sans.corps).toEqual({ error: 'session.requise' });

    const attaquer = async (nom: string, client: Client, ids: Identifiants, statut: number, erreur: string): Promise<void> => {
      const avant = instantane(w);
      const r = await appeler(client, e, ids);
      expect({ attaque: nom, statut: r.statut, corps: r.corps }, `${cle(e)} — ${nom}`).toEqual({ attaque: nom, statut, corps: { error: erreur } });
      expect(instantane(w), `${cle(e)} — ${nom} : la base a changé`).toBe(avant);
    };

    const estGroupe = e.exige === 'appartenance' || e.exige === 'admin' || e.exige === 'organisateur';
    if (estGroupe) {
      // 2. Groupe forgé : même réponse qu'un groupe qui n'existe pas, sans rien confirmer.
      await attaquer('groupe forgé', w.alice.client, idsB, 404, 'groupe.introuvable');
      const inexistant = await appeler(w.alice.client, e, { ...idsB, groupId: '00000000-0000-7000-8000-000000000000' });
      const forge = await appeler(w.alice.client, e, idsB);
      expect({ statut: forge.statut, corps: forge.corps }, 'un groupe étranger ne se distingue pas d’un groupe inexistant').toEqual({ statut: inexistant.statut, corps: inexistant.corps });
      // Groupe forgé AVEC les ressources de A : c'est le groupe qui décide, pas la ressource.
      await attaquer('groupe forgé, ressource de A', w.alice.client, { ...idsA, groupId: w.b.groupId }, 404, 'groupe.introuvable');
    }

    // 3. Identifiant forgé : son groupe, la ressource de B — là où la route le lit (URL, corps, requête), par Alice (étrangère à B)
    // ET par Manon (administratrice de A, membre de B : le groupe de la ressource lui est ouvert, mais pas celui de l'URL).
    for (const [attaquante, client] of [['Alice', w.alice.client], ['Manon (membre de A et de B)', w.manon.client]] as const) {
      for (const [endroit, declaration, libelle] of ENDROITS) {
        for (const [cleForgee, nature] of Object.entries(e[declaration] ?? {})) {
          // Un compte n'est pas cloisonné par le groupe de l'URL mais par un groupe commun avec l'appelant : Manon, membre de B,
          // lit légitimement la photo d'un membre de B. Seule Alice (aucun groupe commun avec lui) joue cette attaque.
          if (nature === 'utilisateur' && client !== w.alice.client) continue;
          const forges: Identifiants = { ...idsA, [endroit]: { ...idsA[endroit], [cleForgee]: w.ressources.b[nature] } };
          await attaquer(`${libelle} (${cleForgee}), par ${attaquante}`, client, forges, 404, INTROUVABLE[nature]);
        }
      }
    }

    // 3 bis. Erin (simple membre, SANS aucun droit sur l'événement) forge l'événement de B : 404, jamais 403. C'est ce qui prouve l'ordre
    // « trouver puis autoriser » avec quelqu'un à qui le 403 s'appliquerait ; les administratrices ci-dessus n'y sont jamais exposées.
    // (Pour une route `organisateur`, seul l'événement : un membre forgé est jugé APRÈS le droit, donc Erin recevrait légitimement un 403
    // avant.) Lot 6 : une route `appartenance` est aussi attaquée par Erin, pour CHAQUE identifiant déclaré — un raccourci réservé aux
    // administrateurs (« l'admin passe, donc on ne vérifie pas la cible ») ne se verrait jamais avec deux attaquantes administratrices.
    if (e.exige === 'organisateur' || e.exige === 'appartenance') {
      for (const [endroit, declaration, libelle] of ENDROITS) {
        for (const [cleForgee, nature] of Object.entries(e[declaration] ?? {})) {
          if (e.exige === 'organisateur' && nature !== 'evenement') continue;
          const forges: Identifiants = { ...idsA, [endroit]: { ...idsA[endroit], [cleForgee]: w.ressources.b[nature] } };
          await attaquer(`${libelle} (${cleForgee}), par Erin (sans droit)`, w.erin.client, forges, 404, INTROUVABLE[nature]);
        }
      }
    }

    // 4. Droit manquant : une simple membre de A (pas de 404 : le groupe est le sien).
    if (e.exige === 'admin') {
      await attaquer('droit manquant', w.erin.client, idsA, 403, 'droit.admin_requis');
    }
    if (e.exige === 'organisateur') {
      await attaquer('droit manquant', w.erin.client, idsA, 403, 'droit.organisateur_requis');
    }

    // 4 bis. Sous-déclaration : une route déclarée `appartenance` doit rester ouverte à une simple membre. Un 403 révèle qu'elle exige
    // l'admin sans que le registre le dise (et la boucle ci-dessus n'aurait jamais attaqué ce droit). Erin ouvre sa propre porte.
    // Une route qui ÉCRIT (supprime, marque un article…) consommerait la ressource ou changerait l'état qu'Alice attend à l'étape 5 (article déjà
    // pris : 409 au lieu de 200). Erin joue alors dans un second monde, jeté après ; seules les lectures partagent le monde d'Alice.
    if (e.exige === 'appartenance') {
      const autre = e.methode === 'GET' ? undefined : await monde();
      try {
        const scene = autre ?? w;
        const membre = await appeler(scene.erin.client, e, { groupId: scene.a.groupId, ...ressourcesDe(e, scene, 'a') });
        if (e.droitFin !== undefined) {
          expect(membre.statut, `${cle(e)} avec droit fin doit refuser Erin en 403`).toBe(403);
          expect(membre.corps).toEqual({ error: e.droitFin });
        } else {
          expect(membre.statut, `${cle(e)} est déclarée « appartenance » mais refuse une simple membre : sous-déclarée (admin ?) — ${JSON.stringify(membre.corps)}`).not.toBe(403);
        }
      } finally {
        autre?.d.nettoyer();
      }
    }

    // 4 ter. Une route `organisateur` doit s'ouvrir à un CO-ORGANISATEUR simple membre (Carole, inscrite dans event_organizers de
    // l'événement de A). Un 403 révèle que la route exige en réalité l'admin (ou l'auteur) : le registre mentirait.
    if (e.exige === 'organisateur') {
      const coOrganisatrice = await appeler(w.carole.client, e, idsA);
      expect(
        coOrganisatrice.statut,
        `${cle(e)} est déclarée « organisateur » mais refuse une co-organisatrice simple membre : sous-déclarée (admin ?) — ${JSON.stringify(coOrganisatrice.corps)}`,
      ).not.toBe(403);
      expect([401, 404], `${cle(e)} avec les identifiants de Carole`).not.toContain(coOrganisatrice.statut);
      expect(coOrganisatrice.statut).toBeLessThan(500);
    }

    // 5. Sa propre route : elle fonctionne (donc les 404 ci-dessus ne viennent pas d'un chemin faux), et ne montre rien de B.
    const propre = await appeler(w.alice.client, e, idsA);
    expect([401, 403, 404], `${cle(e)} avec ses propres identifiants : ${JSON.stringify(propre.corps)}`).not.toContain(propre.statut);
    // Le chemin de SUCCÈS de la route est prouvé : une étape 5 qui ne renvoie plus 2xx (état pollué par une attaque antérieure : article déjà
    // pris, ressource consommée) ne prouverait plus rien.
    if (e.exige === 'appartenance') expect(propre.statut, `${cle(e)} : l'appel légitime d'Alice ne réussit plus (${JSON.stringify(propre.corps)})`).toBeLessThan(300);
    expect(propre.statut).toBeLessThan(500);
    const corps = JSON.stringify(propre.corps) + propre.texte;
    for (const marque of w.marquesDeB) expect(corps, `fuite de « ${marque} » vers un membre de A`).not.toContain(marque);

    // 6. Ancien membre : retirée de A, ses propres identifiants ne mènent plus à rien.
    if (estGroupe) {
      w.d.sql.prepare("UPDATE memberships SET status = 'removed', ended_at = ? WHERE group_id = ? AND user_id = ?").run('2026-11-16T00:00:00Z', w.a.groupId, w.alice.userId);
      await attaquer('ancien membre', w.alice.client, idsA, 404, 'groupe.introuvable');
    }
  });
});
