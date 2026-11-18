import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { purgerAbonnementsRevoques } from '../../server/db/queries/transverse.js';
import { JOUR_MS, versInstant } from '../../server/domain/instant.js';
import { JOURNAL_SILENCIEUX, type Journal } from '../../server/http/middleware/journal.js';
import { demarrerTaches } from '../../server/services/taches.js';
import { ORIGINE, type Decor } from '../fixtures/comptes.js';
import { decor, personne, type Personne } from '../fixtures/groupes.js';

// Entretien des abonnements calendrier : un abonnement révoqué depuis plus de 30 jours est effacé, un révoqué plus récent reste
// visible, un actif n'est jamais touché (quel que soit son âge).
describe('abonnements calendrier : purge des révoqués', () => {
  let d: Decor;
  let alice: Personne;
  beforeEach(async () => {
    d = decor();
    alice = await personne(d, 'alice_p');
  });
  afterEach(() => d.nettoyer());

  const ilYA = (jours: number): string => versInstant(new Date(d.temps.maintenant().getTime() - jours * JOUR_MS));
  const amorcer = (id: string, creeLe: string, revoqueLe: string | null): void => {
    d.sql
      .prepare('INSERT INTO calendar_feed_tokens (id, user_id, token_hash, created_at, revoked_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, alice.userId, `empreinte-${id}`, creeLe, revoqueLe);
  };
  const ids = (): string[] => d.sql.prepare('SELECT id FROM calendar_feed_tokens ORDER BY id').pluck().all() as string[];

  it('supprime le révoqué depuis plus de 30 jours, garde le révoqué récent et l’actif, même très ancien', () => {
    amorcer('ancien_revoque', ilYA(400), ilYA(31));
    amorcer('recent_revoque', ilYA(400), ilYA(29));
    amorcer('actif_ancien', ilYA(900), null);
    expect(purgerAbonnementsRevoques(d.base, ilYA(30))).toBe(1);
    expect(ids()).toEqual(['actif_ancien', 'recent_revoque']);
  });

  it('la tâche d’entretien applique la purge et laisse le reste', async () => {
    amorcer('ancien_revoque', ilYA(400), ilYA(31));
    amorcer('recent_revoque', ilYA(400), ilYA(29));
    amorcer('actif_ancien', ilYA(900), null);
    const lignes: Array<{ message: string; champs: unknown }> = [];
    const journal: Journal = {
      ...JOURNAL_SILENCIEUX,
      info: (message, champs) => lignes.push({ message, champs }),
      error: (message, champs) => lignes.push({ message, champs }),
    };
    const taches = demarrerTaches({ base: d.base, transporteur: undefined, journal, baseUrl: ORIGINE, horloge: d.temps.horloge, intervalleFileMs: 20 });
    try {
      for (let i = 0; i < 100 && ids().length > 2; i++) await new Promise((r) => setTimeout(r, 20));
    } finally {
      await taches.arreter();
    }
    expect(ids()).toEqual(['actif_ancien', 'recent_revoque']);
    expect(lignes).toContainEqual({ message: 'flux.purge', champs: { lignes: 1 } });
  });
});
