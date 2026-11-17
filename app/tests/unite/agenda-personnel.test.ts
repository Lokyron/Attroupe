import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { creerPorteeUtilisateur } from '../../server/db/portee-utilisateur.js';
import {
  creerCreneauPersonnel,
  definirPartagesCreneau,
  lireMaVisibiliteDefaut,
  listerDisponibilitesGroupe,
  modifierCreneauPersonnel,
  modifierMaVisibiliteDefaut,
  supprimerCreneauPersonnel,
} from '../../server/db/queries/agenda-personnel.js';
import { empreintePersonnelleFlux, evenementsPersonnelsFlux } from '../../server/db/queries/flux.js';
import { creerScope } from '../../server/db/scope.js';
import type { AccesFlux } from '../../server/http/middleware/jeton-flux.js';
import {
  changerMaVisibiliteDefaut,
  creerDansMonAgenda,
  definirPartagesDansMonAgenda,
  disponibilitesDuGroupe,
} from '../../server/services/agenda-personnel.js';
import { calculerEtag, fenetreDe, genererFlux } from '../../server/services/flux-ical.js';
import { baseTemporaire, deuxGroupes, type BaseTemporaire, type DeuxGroupes } from '../fixtures/base.js';

const T0 = '2026-06-01T10:00:00Z';

describe('agenda personnel : requêtes et services (lot 8)', () => {
  let t: BaseTemporaire;
  let dg: DeuxGroupes;

  beforeEach(() => {
    t = baseTemporaire();
    dg = deuxGroupes(t.base);
  });

  afterEach(() => {
    t.nettoyer();
  });

  function ajouterMembre(groupId: string, userId: string, membershipId: string, visibilite: 'none' | 'busy' | 'details' = 'busy'): void {
    t.sql
      .prepare(
        `INSERT INTO memberships (id, group_id, user_id, role, default_personal_visibility, joined_at, created_at, updated_at)
         VALUES (?, ?, ?, 'member', ?, ?, ?, ?)`,
      )
      .run(membershipId, groupId, userId, visibilite, T0, T0, T0);
  }

  function creerGroupePourA(groupId: string, membershipId: string, visibilite: 'none' | 'busy' | 'details'): void {
    t.sql
      .prepare(`INSERT INTO groups (id, name, slug, created_by_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(groupId, `Groupe ${groupId}`, `groupe-${groupId.toLowerCase()}`, dg.a.userId, T0, T0);
    ajouterMembre(groupId, dg.a.userId, membershipId, visibilite);
  }

  describe('partage automatique selon default_personal_visibility et modification de la visibilité par défaut', () => {
    it('crée automatiquement les partages selon default_personal_visibility (none, busy, details)', () => {
      creerGroupePourA('g_none', 'm_none', 'none');
      creerGroupePourA('g_busy', 'm_busy', 'busy');
      creerGroupePourA('g_details', 'm_details', 'details');

      const porteeA = creerPorteeUtilisateur(t.base, dg.a.userId);
      const cree = creerCreneauPersonnel(porteeA, {
        title: 'Dentiste',
        description: 'Contrôle annuel',
        location_name: 'Centre ville',
        all_day: false,
        starts_at: '2026-07-10T14:00:00Z',
        ends_at: '2026-07-10T15:00:00Z',
        time_zone: 'Europe/Paris',
      });

      const parGroupe = new Map(cree.partages.map((p) => [p.group_id, p.visibility]));
      expect(parGroupe.has('g_none')).toBe(false);
      expect(parGroupe.get('g_busy')).toBe('busy');
      expect(parGroupe.get('g_details')).toBe('details');
      // Le groupe A d'origine a la valeur par défaut du schéma ('busy').
      expect(parGroupe.get(dg.a.groupId)).toBe('busy');
    });

    it('modifie default_personal_visibility via modifierMaVisibiliteDefaut et l’applique aux prochains créneaux', () => {
      expect(lireMaVisibiliteDefaut(dg.scopeA)).toBe('busy');
      expect(modifierMaVisibiliteDefaut(dg.scopeA, 'details')).toBe(true);
      expect(lireMaVisibiliteDefaut(dg.scopeA)).toBe('details');

      const porteeA = creerPorteeUtilisateur(t.base, dg.a.userId);
      const cree1 = creerDansMonAgenda(porteeA, {
        title: 'Sport',
        description: null,
        location_name: null,
        all_day: false,
        starts_at: '2026-07-11T18:00:00Z',
        ends_at: '2026-07-11T19:00:00Z',
        time_zone: 'Europe/Paris',
      });
      expect(cree1.partages).toEqual([
        { group_id: dg.a.groupId, group_name: 'Groupe A', visibility: 'details' },
      ]);

      expect(changerMaVisibiliteDefaut(dg.scopeA, 'none')).toEqual({ default_personal_visibility: 'none' });
      expect(lireMaVisibiliteDefaut(dg.scopeA)).toBe('none');

      const cree2 = creerDansMonAgenda(porteeA, {
        title: 'Privé',
        description: null,
        location_name: null,
        all_day: false,
        starts_at: '2026-07-12T18:00:00Z',
        ends_at: '2026-07-12T19:00:00Z',
        time_zone: 'Europe/Paris',
      });
      expect(cree2.partages).toEqual([]);
    });
  });

  describe('confidentialité busy vs details et membres retirés (architecture §10)', () => {
    it('ne fuite jamais title, description ni location_name pour un créneau partagé en busy', () => {
      // B devient membre du groupe A pour lire les disponibilités de A.
      ajouterMembre(dg.a.groupId, dg.b.userId, 'mb_dans_a', 'busy');
      const scopeBdansA = creerScope(t.base, dg.b.userId, dg.a.groupId);

      const porteeA = creerPorteeUtilisateur(t.base, dg.a.userId);
      const creneau = creerCreneauPersonnel(porteeA, {
        title: 'Consultation médicale secrète',
        description: 'Détail confidentiel',
        location_name: 'Cabinet',
        all_day: false,
        starts_at: '2026-08-01T09:00:00Z',
        ends_at: '2026-08-01T10:00:00Z',
        time_zone: 'Europe/Paris',
      });
      expect(definirPartagesCreneau(porteeA, creneau.id, [{ group_id: dg.a.groupId, visibility: 'busy' }])).toBe('ok');

      const disposRequete = listerDisponibilitesGroupe(scopeBdansA, { du: '2026-08-01', au: '2026-08-02' });
      expect(disposRequete).toHaveLength(1);
      expect(disposRequete[0]).toMatchObject({
        id: creneau.id,
        visibility: 'busy',
        title: null,
        description: null,
        location_name: null,
      });

      const disposService = disponibilitesDuGroupe(scopeBdansA, { du: '2026-08-01', au: '2026-08-02' });
      const serialise = JSON.stringify(disposService);
      expect(serialise).not.toContain('Consultation médicale secrète');
      expect(serialise).not.toContain('Détail confidentiel');
      expect(serialise).not.toContain('Cabinet');
    });

    it('renvoie title, description et location_name pour un créneau partagé en details', () => {
      ajouterMembre(dg.a.groupId, dg.b.userId, 'mb_dans_a', 'busy');
      const scopeBdansA = creerScope(t.base, dg.b.userId, dg.a.groupId);

      const porteeA = creerPorteeUtilisateur(t.base, dg.a.userId);
      const creneau = creerCreneauPersonnel(porteeA, {
        title: 'Déjeuner ouvert',
        description: 'Qui veut se joindre ?',
        location_name: 'Brasserie du Parc',
        all_day: false,
        starts_at: '2026-08-02T12:00:00Z',
        ends_at: '2026-08-02T13:30:00Z',
        time_zone: 'Europe/Paris',
      });
      expect(definirPartagesCreneau(porteeA, creneau.id, [{ group_id: dg.a.groupId, visibility: 'details' }])).toBe('ok');

      const dispos = listerDisponibilitesGroupe(scopeBdansA, { du: '2026-08-02', au: '2026-08-03' });
      expect(dispos).toHaveLength(1);
      expect(dispos[0]).toMatchObject({
        id: creneau.id,
        visibility: 'details',
        title: 'Déjeuner ouvert',
        description: 'Qui veut se joindre ?',
        location_name: 'Brasserie du Parc',
      });
    });

    it('exclut les créneaux d’un membre retiré (status = removed) de listerDisponibilitesGroupe', () => {
      ajouterMembre(dg.a.groupId, dg.b.userId, 'mb_dans_a', 'details');
      const porteeB = creerPorteeUtilisateur(t.base, dg.b.userId);
      const creneauB = creerCreneauPersonnel(porteeB, {
        title: 'Créneau de B',
        description: null,
        location_name: null,
        all_day: false,
        starts_at: '2026-08-03T10:00:00Z',
        ends_at: '2026-08-03T11:00:00Z',
        time_zone: 'Europe/Paris',
      });

      expect(listerDisponibilitesGroupe(dg.scopeA, { du: '2026-08-03', au: '2026-08-04' }).map((d) => d.id)).toContain(
        creneauB.id,
      );

      // Retrait du membre B du groupe A.
      t.sql.prepare(`UPDATE memberships SET status = 'removed', ended_at = ? WHERE id = ?`).run(T0, 'mb_dans_a');

      expect(listerDisponibilitesGroupe(dg.scopeA, { du: '2026-08-03', au: '2026-08-04' })).toEqual([]);
    });
  });

  describe('definirPartages : rejet d’un groupe étranger et atomicité', () => {
    it('refuse un group_id étranger (groupe_introuvable) sans rien modifier', () => {
      const porteeA = creerPorteeUtilisateur(t.base, dg.a.userId);
      const creneau = creerCreneauPersonnel(porteeA, {
        title: 'Rendez-vous',
        description: null,
        location_name: null,
        all_day: false,
        starts_at: '2026-08-05T10:00:00Z',
        ends_at: '2026-08-05T11:00:00Z',
        time_zone: 'Europe/Paris',
      });
      // Initialement partagé en 'busy' dans le groupe A.
      expect(creneau.partages).toEqual([
        { group_id: dg.a.groupId, group_name: 'Groupe A', visibility: 'busy' },
      ]);

      // Tentative de mise à jour contenant à la fois le groupe A ('details') et le groupe B étranger.
      const res = definirPartagesCreneau(porteeA, creneau.id, [
        { group_id: dg.a.groupId, visibility: 'details' },
        { group_id: dg.b.groupId, visibility: 'busy' },
      ]);
      expect(res).toBe('groupe_introuvable');

      // Aucune écriture partielle : le partage sur le groupe A est resté 'busy'.
      const partageA = t.sql
        .prepare('SELECT visibility FROM personal_event_shares WHERE personal_event_id = ? AND group_id = ?')
        .pluck()
        .get(creneau.id, dg.a.groupId);
      expect(partageA).toBe('busy');

      expect(() =>
        definirPartagesDansMonAgenda(porteeA, creneau.id, [{ group_id: dg.b.groupId, visibility: 'busy' }]),
      ).toThrowError(/groupe\.introuvable/);
    });
  });

  describe('inclusion dans le flux iCal (include_personal = 1 vs 0)', () => {
    function fabriquerAcces(includePersonal: 0 | 1): AccesFlux {
      const porteeA = creerPorteeUtilisateur(t.base, dg.a.userId);
      return {
        jeton: {
          id: 'tok_test',
          user_id: dg.a.userId,
          group_id: null,
          include_personal: includePersonal,
          include_declined: 0,
          revoked_at: null,
        },
        portee: porteeA,
        scopes: [dg.scopeA],
        maintenant: new Date('2026-06-01T12:00:00Z'),
        empreinte: 'empreinte-test',
      };
    }

    it('inclut les créneaux personnels si include_personal = 1 et les exclut si include_personal = 0', () => {
      const porteeA = creerPorteeUtilisateur(t.base, dg.a.userId);
      const creneau = creerCreneauPersonnel(porteeA, {
        title: 'Séance kiné',
        description: 'Apporter serviette',
        location_name: 'Cabinet Nord',
        all_day: false,
        starts_at: '2026-07-15T09:00:00Z',
        ends_at: '2026-07-15T10:00:00Z',
        time_zone: 'Europe/Paris',
      });

      const fenetre = fenetreDe(new Date('2026-06-01T12:00:00Z'), true);
      expect(evenementsPersonnelsFlux(porteeA, fenetre).map((e) => e.id)).toEqual([creneau.id]);
      expect(empreintePersonnelleFlux(porteeA, fenetre)).toContain(creneau.id);

      const fluxSans = genererFlux(fabriquerAcces(0), 'https://attroupe.test');
      expect(fluxSans).not.toContain(`UID:perso-${creneau.id}@attroupe`);
      expect(fluxSans).not.toContain('Séance kiné');

      const fluxAvec = genererFlux(fabriquerAcces(1), 'https://attroupe.test');
      expect(fluxAvec).toContain(`UID:perso-${creneau.id}@attroupe`);
      expect(fluxAvec).toContain('SUMMARY:[Personnel] Séance kiné');
      expect(fluxAvec).toContain('LOCATION:Cabinet Nord');
      expect(fluxAvec.replace(/\r\n /g, '')).toContain('Apporter serviette');
    });

    it('modifie calculerEtag quand un créneau personnel est modifié ou supprimé avec include_personal = 1', () => {
      const porteeA = creerPorteeUtilisateur(t.base, dg.a.userId);
      const creneau = creerCreneauPersonnel(porteeA, {
        title: 'Cours de guitare',
        description: null,
        location_name: null,
        all_day: false,
        starts_at: '2026-07-20T17:00:00Z',
        ends_at: '2026-07-20T18:00:00Z',
        time_zone: 'Europe/Paris',
      });

      const accesAvec = fabriquerAcces(1);
      const accesSans = fabriquerAcces(0);

      const etagAvecAvant = calculerEtag(accesAvec);
      const etagSansAvant = calculerEtag(accesSans);

      // Modification du titre (et mise à jour de updated_at).
      expect(modifierCreneauPersonnel(porteeA, creneau.id, { title: 'Cours de piano' })).toBe(true);
      const etagAvecApresModif = calculerEtag(accesAvec);
      const etagSansApresModif = calculerEtag(accesSans);

      expect(etagAvecApresModif).not.toBe(etagAvecAvant);
      expect(etagSansApresModif).toBe(etagSansAvant);

      // Suppression douce.
      expect(supprimerCreneauPersonnel(porteeA, creneau.id)).toBe(true);
      const etagAvecApresSupp = calculerEtag(accesAvec);
      expect(etagAvecApresSupp).not.toBe(etagAvecApresModif);
      expect(calculerEtag(accesSans)).toBe(etagSansAvant);
    });
  });
});
