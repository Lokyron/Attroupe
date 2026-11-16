import { expect } from 'vitest';
import type { Reponse } from '../fixtures/comptes.js';
import type { JetonCree, Monde } from './monde.js';
import type { EntreeRoute } from './registre.js';

// Les attaques de l'exigence `jetonFlux` (registre.ts) : la route la plus exposée du projet. Elle n'a ni cookie ni groupe dans l'URL et elle
// agrège les événements de plusieurs groupes. Une seule règle à prouver, sous toutes ses formes : le jeton ne désigne que le COMPTE, et ce
// que ce compte peut lire est relu en base à chaque requête.
//
// Les attaquantes sont des SIMPLES MEMBRES (Erin dans A, Dave dans B) et Manon (A et B) : le droit d'administrer n'entre jamais en jeu, donc
// un défaut de cloisonnement ne peut pas se cacher derrière lui (leçon du lot 4).

const ABSENT = { statut: 404, corps: { error: 'flux.introuvable' } } as const;

function chemin(e: EntreeRoute, jeton: string): string {
  return e.chemin.replace(':jeton', jeton);
}

export function nombreDeEvenements(reponse: Reponse): number {
  return reponse.texte.split('\r\n').filter((l) => l === 'BEGIN:VEVENT').length;
}

export async function attaquerFlux(w: Monde, e: EntreeRoute): Promise<void> {
  const anonyme = w.d.client('203.0.113.201'); // aucun cookie : un client de calendrier n'en a pas
  const lire = (jeton: string): Promise<Reponse> => anonyme.get(chemin(e, jeton));
  const ok = async (nom: string, jeton: JetonCree): Promise<Reponse> => {
    const r = await lire(jeton.jeton);
    expect(r.statut, `${nom} : ${r.texte.slice(0, 200)}`).toBe(200);
    expect(r.entetes['content-type'], nom).toBe('text/calendar; charset=utf-8');
    expect(r.texte.startsWith('BEGIN:VCALENDAR\r\n'), nom).toBe(true);
    return r;
  };
  const sansMarqueDeB = (nom: string, r: Reponse): void => {
    for (const marque of w.marquesDeB) expect(r.texte, `${nom} : fuite de « ${marque} » vers un membre de A`).not.toContain(marque);
  };
  const marquesDeA = [w.a.groupId, 'Groupe A', 'Soirée du groupe A', w.ressources.a.evenement];

  // 1. Jeton inconnu, mal formé, ou de la bonne forme mais jamais émis : une seule et même réponse.
  const inconnu = await lire('a'.repeat(52));
  expect({ statut: inconnu.statut, corps: inconnu.corps }, 'jeton inconnu').toEqual(ABSENT);
  for (const [nom, jeton] of [['trop court', 'abc'], ['majuscules', 'A'.repeat(52)], ['caractères hors alphabet', '1'.repeat(52)], ['jeton de session (base64url)', `${'x'.repeat(42)}-`]] as const) {
    const r = await lire(jeton);
    expect({ statut: r.statut, corps: r.corps }, `jeton ${nom}`).toEqual(ABSENT);
  }

  // 2. Jeton révoqué : même réponse que l'inconnu, sans rien dire de plus.
  const aRevoquer = await w.erin.client.post('/api/moi/flux-ical', {});
  const jetonRevoque = aRevoquer.corps['token'] as string;
  expect((await lire(jetonRevoque)).statut, 'avant révocation').toBe(200);
  expect((await w.erin.client.delete(`/api/moi/flux-ical/${aRevoquer.corps['id'] as string}`)).statut).toBe(200);
  const revoque = await lire(jetonRevoque);
  expect({ statut: revoque.statut, corps: revoque.corps }, 'jeton révoqué').toEqual(ABSENT);
  expect(revoque.texte, 'un jeton révoqué ne se distingue pas d’un jeton inconnu').toBe(inconnu.texte);

  // 3. Le jeton d'une simple membre de A : ses événements, et aucune marque de B. Aucun cookie requis.
  const propre = await ok('jeton d’Erin (simple membre de A)', w.flux.erin);
  expect(propre.texte, 'les événements de son groupe sont bien servis (sinon les attaques suivantes ne prouvent rien)').toContain('Soirée du groupe A');
  sansMarqueDeB('jeton d’Erin', propre);
  expect(propre.texte, 'le jeton ne figure jamais dans le contenu du flux').not.toContain(w.flux.erin.jeton);

  // 4. Manon (membre de A ET de B) : son jeton « tous mes groupes » les voit tous les deux — c'est LA preuve que le test suivant n'est pas vacu.
  const tous = await ok('jeton de Manon (tous ses groupes)', w.flux.manonTous);
  expect(tous.texte).toContain('Soirée du groupe A');
  expect(tous.texte).toContain('Soirée du groupe B secret');

  // 5. Jeton RESTREINT à A, présenté par quelqu'un qui est aussi membre de B : rien de B ne filtre.
  const restreintA = await ok('jeton de Manon restreint à A', w.flux.manonRestreintA);
  expect(restreintA.texte).toContain('Soirée du groupe A');
  sansMarqueDeB('jeton de Manon restreint à A', restreintA);

  // 6. Un jeton d'un autre monde ne montre rien du nôtre : Dave (membre de B seul) ne voit aucune marque de A.
  const dave = await ok('jeton de Dave (membre de B seul)', w.flux.dave);
  expect(dave.texte).toContain('Soirée du groupe B secret');
  for (const marque of marquesDeA) expect(dave.texte, `jeton de Dave : fuite de « ${marque} »`).not.toContain(marque);

  // 7. Membre RETIRÉ de A (statut `removed`, historique intact) : son jeton « tous mes groupes » ET son jeton restreint à A ne rendent plus
  // rien de A — ni événement, ni nom de groupe, ni identifiant. Le flux reste un calendrier valide, vide.
  w.d.sql.prepare("UPDATE memberships SET status = 'removed', ended_at = ? WHERE group_id = ? AND user_id = ?").run('2026-11-16T00:00:00Z', w.a.groupId, w.erin.userId);
  for (const [nom, jeton] of [['jeton d’Erin retirée de A', w.flux.erin], ['jeton d’Erin restreint à A, retirée de A', w.flux.erinRestreintA]] as const) {
    const r = await ok(nom, jeton);
    expect(nombreDeEvenements(r), `${nom} : aucun événement`).toBe(0);
    for (const marque of marquesDeA) expect(r.texte, `${nom} : trace de « ${marque} » du groupe quitté`).not.toContain(marque);
    sansMarqueDeB(nom, r);
  }

  // 8. Manon quitte B : son jeton « tous » ne montre plus B ; son jeton restreint à B ne montre plus rien. A reste servi.
  w.d.sql.prepare("UPDATE memberships SET status = 'left', ended_at = ? WHERE group_id = ? AND user_id = ?").run('2026-11-16T00:00:00Z', w.b.groupId, w.manon.userId);
  const apres = await ok('jeton de Manon après son départ de B', w.flux.manonTous);
  expect(apres.texte).toContain('Soirée du groupe A');
  sansMarqueDeB('jeton de Manon après son départ de B', apres);
  const restreintB = await ok('jeton de Manon restreint à B, après son départ', w.flux.manonRestreintB);
  expect(nombreDeEvenements(restreintB)).toBe(0);
  sansMarqueDeB('jeton de Manon restreint à B, après son départ', restreintB);
}
