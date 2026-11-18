// La clé de voûte de l'ADR-0013 : MOI je vois mes rendez-vous, LES AUTRES ne voient que « occupé ».
//
// Les tests voisins éprouvent chaque maillon isolément — l'analyseur lit un SUMMARY, le stockage chiffre, la
// requête de groupe ne sélectionne pas les colonnes chiffrées. Aucun ne prouve que la CHAÎNE tient : qu'un
// titre parti d'un vrai fichier ICS, passé par la synchronisation réelle, ressorte chez son propriétaire et
// nulle part ailleurs. Ce fichier joue ce parcours de bout en bout, par les routes HTTP, et joue l'attaque
// pour de vrai : un autre membre du même groupe lit les disponibilités et ne doit rien trouver.
//
// Il porte aussi le dernier maillon que personne ne couvrait : le branchement des textes de l'analyseur vers
// le stockage. Il était garanti par le typage seul, et un `titre: undefined` oublié aurait été silencieux.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JOURNAL_SILENCIEUX } from '../../server/http/middleware/journal.js';
import { secretFactice } from '../fixtures/env.js';
import { decor, groupe, personne, type Personne } from '../fixtures/groupes.js';
import type { Decor } from '../fixtures/comptes.js';
import { demarrerFauxAgenda, type FauxAgenda } from '../fixtures/faux-agenda.js';

/** Un agenda dont chaque champ est reconnaissable : si l'un d'eux fuit, on le retrouve dans la réponse. */
const TITRE = 'Rendez-vous cardiologue Dr Lefevre';
const DESCRIPTION = 'Apporter les résultats du bilan sanguin';
const LIEU = 'Clinique du Parc, salle 4';

const ICS_INTIME = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Test//FR',
  'BEGIN:VEVENT',
  'UID:intime@test',
  'DTSTART:20261120T100000Z',
  'DTEND:20261120T110000Z',
  `SUMMARY:${TITRE}`,
  `DESCRIPTION:${DESCRIPTION}`,
  `LOCATION:${LIEU}`,
  'END:VEVENT',
  'END:VCALENDAR',
  '',
].join('\r\n');

/** Tous les fragments qui ne doivent JAMAIS sortir vers un groupe, y compris des morceaux de mots. */
const FRAGMENTS_INTERDITS = [TITRE, DESCRIPTION, LIEU, 'cardiologue', 'Lefevre', 'sanguin', 'Clinique', 'salle 4'];

describe('agenda externe de bout en bout : mes détails pour moi, « occupé » pour les autres', () => {
  let faux: FauxAgenda;
  let d: Decor;
  let alice: Personne;
  let bob: Personne;
  let groupId: string;
  const cle = secretFactice();

  beforeEach(async () => {
    faux = await demarrerFauxAgenda();
    faux.reponse = { statut: 200, corps: ICS_INTIME, entetes: { 'content-type': 'text/calendar' } };
    d = decor({ agendaExterne: faux.dependances, journal: JOURNAL_SILENCIEUX }, { ATTROUPE_ENCRYPTION_KEY: cle });
    alice = await personne(d, 'alice_bout');
    bob = await personne(d, 'bob_bout');
    // `default_personal_visibility` vaut « busy » à la création : l'import partage donc au groupe sans réglage.
    ({ groupId } = await groupe(d, 'Les amis', [
      { personne: alice, role: 'admin' },
      { personne: bob, role: 'member' },
    ]));
    const creation = await alice.client.post('/api/moi/agenda/sources', { url: faux.url, label: 'Mon agenda perso' });
    expect(creation.statut, JSON.stringify(creation.corps)).toBe(201);
    const synchro = creation.corps['synchronisation'] as { statut: string; creneaux_importes: number };
    expect(synchro.statut).toBe('ok');
    expect(synchro.creneaux_importes).toBe(1);
  });

  afterEach(async () => {
    d.nettoyer();
    await faux.arreter();
  });

  it('Alice retrouve le titre, la description et le lieu de SON rendez-vous', async () => {
    const r = await alice.client.get('/api/moi/agenda?du=2026-11-01&au=2026-12-31');
    expect(r.statut).toBe(200);
    const creneaux = r.corps['creneaux'] as Array<Record<string, unknown>>;
    const importe = creneaux.find((c) => c['calendar_source_id'] !== null);
    expect(importe, 'le créneau importé est absent de mon propre agenda').toBeDefined();
    expect(importe?.['title']).toBe(TITRE);
    expect(importe?.['description']).toBe(DESCRIPTION);
    expect(importe?.['location_name']).toBe(LIEU);
  });

  it('les colonnes en clair restent VIDES en base : il n’y a rien à sélectionner par erreur', () => {
    const ligne = d.sql
      .prepare("SELECT title, description, location_name, details_cipher, details_nonce FROM personal_events WHERE calendar_source_id IS NOT NULL")
      .get() as Record<string, unknown>;
    expect(ligne['title']).toBe('');
    expect(ligne['description']).toBeNull();
    expect(ligne['location_name']).toBeNull();
    expect(ligne['details_cipher']).not.toBeNull();
    expect(ligne['details_nonce']).not.toBeNull();
  });

  it('le texte chiffré en base ne contient aucun fragment lisible', () => {
    const ligne = d.sql.prepare('SELECT details_cipher FROM personal_events WHERE calendar_source_id IS NOT NULL').get() as Record<string, unknown>;
    const brut = Buffer.from(ligne['details_cipher'] as Uint8Array);
    for (const encodage of ['utf8', 'latin1', 'utf16le'] as const) {
      const lisible = brut.toString(encodage);
      for (const fragment of FRAGMENTS_INTERDITS) {
        expect(lisible, `« ${fragment} » lisible en ${encodage} dans le chiffré`).not.toContain(fragment);
      }
    }
  });

  // LE test de l'ADR : l'attaque, jouée pour de vrai.
  it('Bob, membre du MÊME groupe, ne voit qu’« occupé » — aucun mot du rendez-vous', async () => {
    const r = await bob.client.get(`/api/groupes/${groupId}/disponibilites?du=2026-11-01&au=2026-12-31`);
    expect(r.statut).toBe(200);
    const dispos = r.corps['disponibilites'] as Array<Record<string, unknown>>;
    expect(dispos.length, 'Bob devrait voir la plage occupée d’Alice').toBeGreaterThan(0);

    for (const dispo of dispos) {
      expect(dispo['visibility']).toBe('busy');
      expect(dispo['title']).toBeNull();
      expect(dispo['description']).toBeNull();
      expect(dispo['location_name']).toBeNull();
    }

    // Et surtout : rien nulle part dans la réponse entière, champs inconnus compris.
    const serialise = JSON.stringify(r.corps);
    for (const fragment of FRAGMENTS_INTERDITS) {
      expect(serialise, `« ${fragment} » a fui vers le groupe`).not.toContain(fragment);
    }
    expect(serialise).not.toContain('details_cipher');
    expect(serialise).not.toContain('details_nonce');
  });

  it('Bob ne peut pas davantage lire l’agenda personnel d’Alice en passant par /api/moi', async () => {
    const r = await bob.client.get('/api/moi/agenda?du=2026-11-01&au=2026-12-31');
    expect(r.statut).toBe(200);
    const creneaux = r.corps['creneaux'] as Array<Record<string, unknown>>;
    expect(creneaux, 'l’agenda de Bob doit être vide : celui d’Alice ne lui appartient pas').toHaveLength(0);
  });

  it('le flux iCal sortant d’Alice n’emporte pas ses créneaux importés', async () => {
    const creation = await alice.client.post('/api/moi/flux-ical', { label: 'iPhone', include_personal: true });
    expect(creation.statut).toBe(201);
    const url = new URL(creation.corps['url'] as string);
    const flux = await alice.client.get(url.pathname);
    expect(flux.statut).toBe(200);
    const texte = String(flux.corps);
    for (const fragment of FRAGMENTS_INTERDITS) {
      expect(texte, `« ${fragment} » est reparti dans le flux sortant`).not.toContain(fragment);
    }
  });
});
