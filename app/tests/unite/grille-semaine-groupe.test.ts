import { describe, expect, it } from 'vitest';
import { entreesDepuisGroupe } from '../../client/src/agenda/grille-semaine-groupe.js';

// Adaptateur de la page agenda d'un groupe vers la grille de la semaine.
const evenement = (extra: object = {}) => ({
  id: 'e1',
  title: 'Barbecue',
  status: 'published',
  all_day: false,
  starts_at: '2027-03-16T17:00:00Z',
  ends_at: '2027-03-16T20:00:00Z',
  time_zone: 'Europe/Paris',
  ...extra,
});

const dispo = (extra: object = {}) => ({
  id: 'd1',
  membership_id: 'm1',
  display_name: 'Camille',
  visibility: 'busy' as const,
  title: null,
  all_day: false,
  starts_at: '2027-03-16T08:00:00Z',
  ends_at: '2027-03-16T09:00:00Z',
  time_zone: 'Europe/Paris',
  ...extra,
});

const lien = {
  lienEvenement: (id: string): string => `#/groupe/g1/evenement/${id}`,
  titreOccupe: (nom: string): string => `${nom} — Occupé`,
  titreDetails: (nom: string, titre: string): string => `${nom} — ${titre}`,
};

describe('adaptateur de la page agenda du groupe', () => {
  it('un événement devient une entrée cliquable, vers son lien', () => {
    const [e] = entreesDepuisGroupe([evenement()], [], lien);
    expect(e).toMatchObject({ cle: 'evenement-e1', titre: 'Barbecue', lien: '#/groupe/g1/evenement/e1', genre: 'evenement', annule: false });
    expect(e?.starts_at).toBe('2027-03-16T17:00:00Z');
  });

  it('un événement annulé est marqué comme tel, un brouillon non', () => {
    const [annule, brouillon] = entreesDepuisGroupe([evenement({ status: 'cancelled' }), evenement({ id: 'e2', status: 'draft' })], [], lien);
    expect(annule?.annule).toBe(true);
    expect(brouillon?.annule).toBe(false);
  });

  it('une disponibilité « occupé » n’expose ni titre ni lien : seulement le nom du membre', () => {
    const [d] = entreesDepuisGroupe([], [dispo({ title: 'Rendez-vous médical' })], lien);
    expect(d).toMatchObject({ cle: 'occupe-d1-m1', genre: 'occupe', lien: null });
    expect(d?.titre).toContain('Camille');
    expect(d?.titre).not.toContain('Rendez-vous médical');
  });

  it('une disponibilité avec détails montre le titre', () => {
    const [d] = entreesDepuisGroupe([], [dispo({ visibility: 'details', title: 'Dentiste' })], lien);
    expect(d?.titre).toContain('Camille');
    expect(d?.titre).toContain('Dentiste');
  });

  it('une disponibilité « détails » sans titre retombe sur « occupé »', () => {
    const [d] = entreesDepuisGroupe([], [dispo({ visibility: 'details', title: null })], lien);
    expect(d?.titre).toContain('Occupé');
  });

  it('la même disponibilité vue par deux membres donne deux clés distinctes', () => {
    const entrees = entreesDepuisGroupe([], [dispo(), dispo({ membership_id: 'm2' })], lien);
    expect(new Set(entrees.map((e) => e.cle)).size).toBe(2);
  });
});
