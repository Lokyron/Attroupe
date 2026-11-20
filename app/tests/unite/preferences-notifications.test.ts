import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GENRES_NOTIFICATION as GENRES_SERVEUR } from '../../server/domain/notifications.js';
import { schemaPreferenceNotification } from '../../server/http/schemas/notifications.js';
import {
  basculerGenre,
  corpsPreference,
  GENRES_NON_EMIS,
  GENRES_NOTIFICATION,
  preferenceEffective,
  THEMES_NOTIFICATION,
  type PreferenceBrute,
} from '../../client/src/lib/preferences-notifications.js';

const fr: Record<string, string> = JSON.parse(readFileSync(join(__dirname, '../../client/src/i18n/fr.json'), 'utf8')) as Record<string, string>;

const globale: PreferenceBrute = { group_id: '*', email_mode: 'daily', muted_kinds: ['expense_added'] };
const groupeA: PreferenceBrute = { group_id: 'a', email_mode: 'off', muted_kinds: [] };
const groupeSansRien: PreferenceBrute = { group_id: 'c', email_mode: null, muted_kinds: null };

describe('liste des genres', () => {
  it('reste alignée sur celle du serveur', () => {
    expect([...GENRES_NOTIFICATION]).toEqual([...GENRES_SERVEUR]);
  });

  it('range chaque genre émis dans exactement un thème, et tout est libellé en français', () => {
    const rangés = THEMES_NOTIFICATION.flatMap((th) => th.genres);
    expect([...rangés, ...GENRES_NON_EMIS].sort()).toEqual([...GENRES_NOTIFICATION].sort());
    const cles = new Set(Object.keys(fr));
    for (const g of rangés) expect(cles.has(`notifications.genre_${g}`), g).toBe(true);
    for (const th of THEMES_NOTIFICATION) expect(cles.has(`notifications.theme_${th.cle}`), th.cle).toBe(true);
  });
});

describe('corpsPreference', () => {
  it('un envoi de genres seuls ne contient pas email_mode', () => {
    const corps = corpsPreference('a', { muted_kinds: ['message_posted'] });
    expect(corps).toEqual({ group_id: 'a', muted_kinds: ['message_posted'] });
    expect('email_mode' in corps).toBe(false);
  });

  it('un envoi de mode seul ne contient pas muted_kinds (sinon le serveur viderait la liste)', () => {
    const corps = corpsPreference('a', { email_mode: 'off' });
    expect(corps).toEqual({ group_id: 'a', email_mode: 'off' });
    expect('muted_kinds' in corps).toBe(false);
  });

  it('une liste vide est envoyée (rien n’est coupé) : ce n’est pas un champ absent', () => {
    expect(corpsPreference('*', { muted_kinds: [] })).toEqual({ group_id: '*', muted_kinds: [] });
  });

  it('refuse un changement vide et dédoublonne les genres', () => {
    expect(() => corpsPreference('a', {})).toThrow();
    expect(corpsPreference('a', { muted_kinds: ['event_created', 'event_created'] }).muted_kinds).toEqual(['event_created']);
  });

  it('produit un corps accepté par le schéma du serveur', () => {
    for (const changement of [{ email_mode: 'daily' as const }, { muted_kinds: [...GENRES_NOTIFICATION] }, { email_mode: 'off' as const, muted_kinds: [] }]) {
      expect(schemaPreferenceNotification.safeParse(corpsPreference('a', changement)).success).toBe(true);
    }
  });
});

describe('preferenceEffective', () => {
  it('les champs posés par le groupe priment, y compris une liste vide (qui rétablit les genres coupés globalement)', () => {
    expect(preferenceEffective([globale, groupeA], 'a')).toEqual({
      email_mode: 'off', muted_kinds: [], mode_propre: true, genres_propres: true, suit_global: false,
    });
  });

  it('un groupe sans ligne, ou dont les champs sont à null, suit entièrement la globale', () => {
    const suit = { email_mode: 'daily', muted_kinds: ['expense_added'], mode_propre: false, genres_propres: false, suit_global: true };
    expect(preferenceEffective([globale, groupeA], 'b')).toEqual(suit);
    expect(preferenceEffective([globale, groupeSansRien], 'c')).toEqual(suit);
  });

  it('résolution champ par champ : le groupe qui ne pose que le mode garde les genres coupés globalement, et inversement', () => {
    const modeSeul: PreferenceBrute = { group_id: 'm', email_mode: 'immediate', muted_kinds: null };
    const genresSeuls: PreferenceBrute = { group_id: 'g', email_mode: null, muted_kinds: ['member_joined'] };
    expect(preferenceEffective([globale, modeSeul], 'm')).toEqual({
      email_mode: 'immediate', muted_kinds: ['expense_added'], mode_propre: true, genres_propres: false, suit_global: false,
    });
    expect(preferenceEffective([globale, genresSeuls], 'g')).toEqual({
      email_mode: 'daily', muted_kinds: ['member_joined'], mode_propre: false, genres_propres: true, suit_global: false,
    });
  });

  it('sans aucune ligne : e-mail immédiat, rien de coupé', () => {
    expect(preferenceEffective([], 'a')).toEqual({ email_mode: 'immediate', muted_kinds: [], mode_propre: false, genres_propres: false, suit_global: true });
    // Groupe seul, sans ligne globale : le champ non posé retombe sur le défaut.
    expect(preferenceEffective([{ group_id: 'a', email_mode: null, muted_kinds: ['event_created'] }], 'a')).toMatchObject({ email_mode: 'immediate', muted_kinds: ['event_created'] });
  });

  it('la portée globale ignore les lignes de groupe', () => {
    expect(preferenceEffective([groupeA, globale], '*').email_mode).toBe('daily');
  });
});

describe('basculerGenre', () => {
  it('coupe et rétablit sans doublon, dans l’ordre canonique', () => {
    const a = basculerGenre(['message_posted'], 'event_created', true);
    expect(a).toEqual(['event_created', 'message_posted']);
    expect(basculerGenre(a, 'event_created', true)).toEqual(a);
    expect(basculerGenre(a, 'message_posted', false)).toEqual(['event_created']);
  });

  it('ne modifie pas la liste d’origine', () => {
    const origine = ['expense_added'] as const;
    basculerGenre(origine, 'member_joined', true);
    expect(origine).toEqual(['expense_added']);
  });
});
