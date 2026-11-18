import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { creerPorteeUtilisateur } from '../../server/db/portee-utilisateur.js';
import { creerCreneauPersonnel } from '../../server/db/queries/agenda-personnel.js';
import { creerSource, remplacerCreneauxImportes } from '../../server/db/queries/agenda-externe.js';
import { empreintePersonnelleFlux, evenementsPersonnelsFlux } from '../../server/db/queries/flux.js';
import { fenetreDe } from '../../server/services/flux-ical.js';
import { baseTemporaire, deuxGroupes, type BaseTemporaire, type DeuxGroupes } from '../fixtures/base.js';
import { secretFactice } from '../fixtures/env.js';

// Boucle de rétroaction (ADR-0013 §5) : les créneaux IMPORTÉS d'un agenda externe ne repartent jamais dans le flux iCal sortant. Sinon le
// téléphone, abonné au flux, réafficherait en double les rendez-vous qu'il a lui-même produits. La lecture ET l'empreinte ETag dérivent de la
// même constante (`CORPS_ENSEMBLE_PERSONNEL`) : une seule exclusion les couvre toutes les deux.

describe('flux iCal sortant : les créneaux importés n’y entrent pas', () => {
  let t: BaseTemporaire;
  let dg: DeuxGroupes;
  const cle = secretFactice();
  beforeEach(() => {
    t = baseTemporaire();
    dg = deuxGroupes(t.base);
  });
  afterEach(() => t.nettoyer());

  const fenetre = fenetreDe(new Date('2026-11-15T12:00:00Z'), true);
  const plage = (debut: string, fin: string) => ({ starts_at: debut, ends_at: fin, all_day: false, time_zone: 'Europe/Paris' });

  function amorcer() {
    const portee = creerPorteeUtilisateur(t.base, dg.a.userId);
    const manuel = creerCreneauPersonnel(portee, {
      title: 'Dentiste',
      description: null,
      location_name: null,
      all_day: false,
      starts_at: '2026-11-20T09:00:00Z',
      ends_at: '2026-11-20T10:00:00Z',
      time_zone: 'Europe/Paris',
    });
    const source = creerSource(portee, { label: 'Google', url: 'https://agenda.exemple.org/a.ics', hote: 'agenda.exemple.org', prochaineTentative: '2026-11-15T12:00:00Z' }, cle);
    if (!source.ok) throw new Error('Source non créée.');
    remplacerCreneauxImportes(portee, source.id, [plage('2026-11-21T09:00:00Z', '2026-11-21T10:00:00Z')], cle);
    return { portee, manuel, sourceId: source.id };
  }

  const idsImportes = (): string[] => t.sql.prepare('SELECT id FROM personal_events WHERE calendar_source_id IS NOT NULL ORDER BY id').pluck().all() as string[];

  it('la lecture ne rend que le créneau saisi à la main', () => {
    const { portee, manuel } = amorcer();
    expect(idsImportes()).toHaveLength(1);
    expect(evenementsPersonnelsFlux(portee, fenetre).map((e) => e.id)).toEqual([manuel.id]);
  });

  it('l’empreinte ETag ne contient pas le créneau importé et ne bouge pas quand l’import est remplacé', () => {
    const { portee, manuel, sourceId } = amorcer();
    const avant = empreintePersonnelleFlux(portee, fenetre);
    expect(avant).toContain(manuel.id);
    expect(avant).not.toContain(idsImportes()[0]);
    // Une synchronisation remplace le lot (nouveaux identifiants, nouvelles dates) : le flux, lui, ne doit pas frémir.
    remplacerCreneauxImportes(portee, sourceId, [plage('2026-11-22T09:00:00Z', '2026-11-22T10:00:00Z'), plage('2026-11-23T09:00:00Z', '2026-11-23T10:00:00Z')], cle);
    expect(empreintePersonnelleFlux(portee, fenetre)).toBe(avant);
  });
});
