import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { creerPorteeUtilisateur } from '../../server/db/portee-utilisateur.js';
import {
  COUPLES_DISPONIBILITE,
  creerCreneauPersonnel,
  listerDisponibilitesGroupe,
  modifierCreneauPersonnel,
  supprimerCreneauPersonnel,
} from '../../server/db/queries/agenda-personnel.js';
import { empreintePersonnelleFlux, evenementsPersonnelsFlux } from '../../server/db/queries/flux.js';
import { creerScope } from '../../server/db/scope.js';
import { plafonner, RANG_VISIBILITE, type VisibilitePartage } from '../../server/domain/visibilite-personnelle.js';
import type { AccesFlux } from '../../server/http/middleware/jeton-flux.js';
import { creerDansMonAgenda, disponibilitesDuGroupe } from '../../server/services/agenda-personnel.js';
import { calculerEtag, fenetreDe, genererFlux } from '../../server/services/flux-ical.js';
import { baseTemporaire, deuxGroupes, type BaseTemporaire, type DeuxGroupes } from '../fixtures/base.js';

const T0 = '2026-06-01T10:00:00Z';
const NIVEAUX: readonly VisibilitePartage[] = ['none', 'busy', 'details'];

describe('plafonner : la seule combinaison du réglage de compte et du partage (ADR-0017)', () => {
  it('est un minimum sur none < busy < details, pour les 9 couples', () => {
    for (const plafond of NIVEAUX) {
      for (const demandee of NIVEAUX) {
        const attendu = RANG_VISIBILITE[plafond] <= RANG_VISIBILITE[demandee] ? plafond : demandee;
        expect(plafonner(plafond, demandee)).toBe(attendu);
      }
    }
    expect(plafonner('none', 'details')).toBe('none');
    expect(plafonner('busy', 'details')).toBe('busy');
    expect(plafonner('details', 'busy')).toBe('busy');
    expect(plafonner('details', 'details')).toBe('details');
  });

  it('la table des couples de listerDisponibilitesGroupe est exactement le minimum du treillis', () => {
    // Un plafond « none » n'a aucun couple (aucune requête), un partage n'est jamais « none » : 2 x 2 couples.
    expect(COUPLES_DISPONIBILITE).toHaveLength(4);
    for (const plafond of ['busy', 'details'] as const) {
      for (const partage of ['busy', 'details'] as const) {
        const couple = COUPLES_DISPONIBILITE.filter((c) => c.plafond === plafond && c.partage === partage);
        expect(couple).toEqual([{ plafond, partage, effective: plafonner(plafond, partage) }]);
      }
    }
    // Le texte « détails » n'est exécuté que pour (details, details) ; « occupé » trois fois.
    expect(COUPLES_DISPONIBILITE.filter((c) => c.effective === 'details')).toHaveLength(1);
    expect(COUPLES_DISPONIBILITE.filter((c) => c.effective === 'busy')).toHaveLength(3);
  });
});

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

  function ajouterMembre(groupId: string, userId: string, membershipId: string): void {
    t.sql
      .prepare(
        `INSERT INTO memberships (id, group_id, user_id, role, joined_at, created_at, updated_at)
         VALUES (?, ?, ?, 'member', ?, ?, ?)`,
      )
      .run(membershipId, groupId, userId, T0, T0, T0);
  }

  function creerGroupePourA(groupId: string, membershipId: string): void {
    t.sql
      .prepare(`INSERT INTO groups (id, name, slug, created_by_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(groupId, `Groupe ${groupId}`, `groupe-${groupId.toLowerCase()}`, dg.a.userId, T0, T0);
    ajouterMembre(groupId, dg.a.userId, membershipId);
  }

  /** Pose le réglage de compte directement en base (le test de l'API est dans tests/integration). */
  function regler(userId: string, valeur: VisibilitePartage): void {
    t.sql.prepare('UPDATE users SET personal_agenda_visibility = ? WHERE id = ?').run(valeur, userId);
  }

  function partagesDe(creneauId: string): Array<{ group_id: string; visibility: string }> {
    return t.sql
      .prepare('SELECT group_id, visibility FROM personal_event_shares WHERE personal_event_id = ? ORDER BY group_id')
      .all(creneauId) as Array<{ group_id: string; visibility: string }>;
  }

  const CRENEAU = {
    title: 'Dentiste',
    description: 'Contrôle annuel',
    location_name: 'Centre ville',
    all_day: false,
    starts_at: '2026-07-10T14:00:00Z',
    ends_at: '2026-07-10T15:00:00Z',
    time_zone: 'Europe/Paris',
  } as const;

  describe('partages écrits à la création selon le réglage de compte', () => {
    it('écrit plafonner(réglage, details) pour chaque appartenance active, et rien si le réglage est none', () => {
      creerGroupePourA('g_2', 'm_2');
      const porteeA = creerPorteeUtilisateur(t.base, dg.a.userId);
      const groupes = [dg.a.groupId, 'g_2'].sort();

      // Réglage par défaut (busy).
      const parDefaut = creerCreneauPersonnel(porteeA, CRENEAU);
      expect(partagesDe(parDefaut.id)).toEqual(groupes.map((group_id) => ({ group_id, visibility: 'busy' })));

      regler(dg.a.userId, 'details');
      const detaille = creerCreneauPersonnel(porteeA, CRENEAU);
      expect(partagesDe(detaille.id)).toEqual(groupes.map((group_id) => ({ group_id, visibility: 'details' })));

      regler(dg.a.userId, 'none');
      const cache = creerDansMonAgenda(porteeA, CRENEAU);
      expect(partagesDe(cache.id)).toEqual([]);
    });
  });

  describe('confidentialité busy vs details et membres retirés (architecture §10)', () => {
    it('ne fuite jamais title, description ni location_name pour un créneau lu en busy', () => {
      // B devient membre du groupe A pour lire les disponibilités de A.
      ajouterMembre(dg.a.groupId, dg.b.userId, 'mb_dans_a');
      const scopeBdansA = creerScope(t.base, dg.b.userId, dg.a.groupId);

      const porteeA = creerPorteeUtilisateur(t.base, dg.a.userId);
      const creneau = creerCreneauPersonnel(porteeA, {
        ...CRENEAU,
        title: 'Consultation médicale secrète',
        description: 'Détail confidentiel',
        location_name: 'Cabinet',
        starts_at: '2026-08-01T09:00:00Z',
        ends_at: '2026-08-01T10:00:00Z',
      });

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

    it('renvoie title, description et location_name quand le réglage ET le partage valent details', () => {
      ajouterMembre(dg.a.groupId, dg.b.userId, 'mb_dans_a');
      const scopeBdansA = creerScope(t.base, dg.b.userId, dg.a.groupId);
      regler(dg.a.userId, 'details');

      const porteeA = creerPorteeUtilisateur(t.base, dg.a.userId);
      const creneau = creerCreneauPersonnel(porteeA, {
        ...CRENEAU,
        title: 'Déjeuner ouvert',
        description: 'Qui veut se joindre ?',
        location_name: 'Brasserie du Parc',
        starts_at: '2026-08-02T12:00:00Z',
        ends_at: '2026-08-02T13:30:00Z',
      });

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

    it('couvre les 9 couples (réglage, partage) : le résultat suit plafonner, jamais une ligne seule', () => {
      ajouterMembre(dg.a.groupId, dg.b.userId, 'mb_dans_a');
      const scopeBdansA = creerScope(t.base, dg.b.userId, dg.a.groupId);
      const porteeA = creerPorteeUtilisateur(t.base, dg.a.userId);
      const creneau = creerCreneauPersonnel(porteeA, { ...CRENEAU, starts_at: '2026-08-06T10:00:00Z', ends_at: '2026-08-06T11:00:00Z' });

      for (const reglage of NIVEAUX) {
        for (const partage of ['busy', 'details'] as const) {
          regler(dg.a.userId, reglage);
          // La ligne est écrite directement : ni plafond ni réalignement n'interviennent à l'écriture.
          t.sql.prepare('UPDATE personal_event_shares SET visibility = ? WHERE personal_event_id = ? AND group_id = ?').run(partage, creneau.id, dg.a.groupId);
          const effective = plafonner(reglage, partage);
          const lu = listerDisponibilitesGroupe(scopeBdansA, { du: '2026-08-06', au: '2026-08-07' });
          if (effective === 'none') {
            expect(lu).toEqual([]);
          } else {
            expect(lu).toHaveLength(1);
            expect(lu[0]?.visibility).toBe(effective);
            expect(lu[0]?.title).toBe(effective === 'details' ? CRENEAU.title : null);
          }
        }
      }
    });

    it('exclut les créneaux d’un membre retiré (status = removed) de listerDisponibilitesGroupe', () => {
      ajouterMembre(dg.a.groupId, dg.b.userId, 'mb_dans_a');
      const porteeB = creerPorteeUtilisateur(t.base, dg.b.userId);
      const creneauB = creerCreneauPersonnel(porteeB, {
        ...CRENEAU,
        title: 'Créneau de B',
        description: null,
        location_name: null,
        starts_at: '2026-08-03T10:00:00Z',
        ends_at: '2026-08-03T11:00:00Z',
      });

      expect(listerDisponibilitesGroupe(dg.scopeA, { du: '2026-08-03', au: '2026-08-04' }).map((d) => d.id)).toContain(
        creneauB.id,
      );

      // Retrait du membre B du groupe A.
      t.sql.prepare(`UPDATE memberships SET status = 'removed', ended_at = ? WHERE id = ?`).run(T0, 'mb_dans_a');

      expect(listerDisponibilitesGroupe(dg.scopeA, { du: '2026-08-03', au: '2026-08-04' })).toEqual([]);
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

      // Le flux lit l'agenda DU PROPRIÉTAIRE : le réglage de compte (« busy » par défaut) ne le plafonne pas (ADR-0017, décision 8).
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
