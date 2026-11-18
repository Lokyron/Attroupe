// Un e-mail part chez quelqu'un d'autre : on ne le relit pas avant qu'il soit trop tard.
//
// Ces tests figent le contrat de la mise en page HTML (ADR-0013 n'en parle pas : c'est le module
// `services/emails.ts`). Trois choses y sont en jeu, dans cet ordre d'importance :
//
//  1. L'ÉCHAPPEMENT. Un nom de groupe est écrit par un utilisateur, et il part dans le HTML d'un e-mail
//     envoyé à quelqu'un d'autre. C'est une injection par rebond : la victime n'est pas celle qui écrit.
//  2. Le lien doit RESTER ATTEIGNABLE même sans le bouton — client qui bloque les images, mode texte,
//     bouton mal rendu par Outlook. D'où le rappel de l'adresse en toutes lettres.
//  3. Le texte brut reste la source de vérité et doit continuer à contenir l'adresse : c'est lui que lisent
//     les clients en mode texte, et il compte dans la note anti-spam.
import { describe, expect, it } from 'vitest';
import { rendre } from '../../server/services/emails.js';
import fr from '../../server/i18n/fr.json' with { type: 'json' };

const BASE = 'https://beta.attroupe.fr';
const LIEN = `${BASE}/verification-email#jeton=${'a'.repeat(43)}`;
const CLES = Object.keys((fr as { emails: Record<string, unknown> }).emails);

/** Charge utile minimale par gabarit : toutes les variables que son texte réclame. */
const CHARGES: Readonly<Record<string, Record<string, string>>> = {
  verification_email: { nom: 'Théo' },
  reinitialisation_mot_de_passe: { nom: 'Théo' },
  compte_existant: { nom: 'Théo' },
  invitation_groupe: { invitant: 'Camille', groupe: 'Week-end à Sète', mot: '' },
  notification_immediate: { nom: 'Théo', groupe: 'Week-end à Sète' },
  resume_quotidien: { nom: 'Théo', groupe: 'Week-end à Sète', nombre: '5' },
};

const rendu = (cle: string, variables: Record<string, string> = {}) =>
  rendre(cle, JSON.stringify({ ...CHARGES[cle], ...variables }), 'fr', { lien: LIEN }, BASE);

describe('gabarits d’e-mail : mise en page HTML', () => {
  it('chaque gabarit porte un libellé de bouton — sans quoi son lien resterait une URL nue', () => {
    const emails = (fr as { emails: Record<string, { action?: string }> }).emails;
    for (const cle of CLES) {
      expect(emails[cle]?.action, `le gabarit « ${cle} » n’a pas de libellé d’action`).toBeTruthy();
    }
  });

  it.each(CLES)('%s : le lien devient un bouton, et non un paragraphe d’URL nue', (cle) => {
    const { html } = rendu(cle);
    const emails = (fr as { emails: Record<string, { action?: string }> }).emails;
    const libelle = emails[cle]?.action ?? '';
    // Le lien est dans un bouton (un tableau, pour Outlook) portant le libellé du gabarit…
    expect(html).toContain(`<a href="${LIEN}" style="display:inline-block;`);
    expect(html).toContain(`>${libelle}</a>`);
    // …et non rendu comme un paragraphe dont le texte visible serait l'URL elle-même.
    expect(html).not.toMatch(new RegExp(`<p[^>]*>\\s*<a href="[^"]*"[^>]*>https?://`));
  });

  it.each(CLES)('%s : l’adresse est rappelée en clair, pour qui n’a pas le bouton', (cle) => {
    const { html } = rendu(cle);
    expect(html).toContain('Si le bouton ne fonctionne pas');
    // Deux fois : une dans le href du bouton, une dans le rappel lisible.
    expect(html.split(LIEN).length - 1).toBeGreaterThanOrEqual(2);
  });

  it.each(CLES)('%s : le texte brut contient toujours l’adresse', (cle) => {
    expect(rendu(cle).texte).toContain(LIEN);
  });

  it.each(CLES)('%s : le logo est une adresse ABSOLUE (un chemin relatif ne s’affiche pas en e-mail)', (cle) => {
    expect(rendu(cle).html).toContain(`src="${BASE}/icons/logo.png"`);
  });

  it.each(CLES)('%s : porte un texte d’aperçu, et ce n’est pas « Bonjour »', (cle) => {
    const { html } = rendu(cle);
    const apercu = html.match(/opacity:0;">([^<]*)</)?.[1] ?? '';
    expect(apercu.length, 'aperçu vide : la boîte de réception affichera le début du corps').toBeGreaterThan(10);
    expect(apercu.startsWith('Bonjour')).toBe(false);
  });

  // L'injection par rebond : le nom du groupe est écrit par un tiers, et lu par la victime.
  it('un nom de groupe hostile est échappé dans le HTML', () => {
    const hostile = '<script>alert(1)</script> & "guillemets"';
    const { html, texte } = rendu('invitation_groupe', { groupe: hostile });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp;');
    expect(html).toContain('&quot;');
    // Le texte brut, lui, n'est pas du HTML : il garde les caractères tels quels.
    expect(texte).toContain('<script>');
  });

  it('un nom d’invitant hostile est échappé lui aussi', () => {
    const { html } = rendu('invitation_groupe', { invitant: '<img src=x onerror=alert(1)>' });
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img');
  });

  it('le libellé du bouton est échappé : il vient du fichier de textes, mais la règle ne se discute pas', () => {
    const { html } = rendu('verification_email');
    const bouton = html.match(/border-radius:10px;">([^<]*)</)?.[1] ?? '';
    expect(bouton).not.toContain('<');
  });

  it('le HTML est un document complet, en français, et déclare son encodage', () => {
    const { html } = rendu('verification_email');
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('lang="fr"');
    expect(html).toContain('charset="utf-8"');
    expect(html).toContain('</html>');
  });

  it('un gabarit inconnu est refusé, il ne part pas à moitié rendu', () => {
    expect(() => rendre('gabarit_qui_n_existe_pas', '{}', 'fr', {}, BASE)).toThrow();
  });

  it('une variable manquante laisse son motif visible plutôt que d’inventer', () => {
    const { texte } = rendre('verification_email', '{}', 'fr', { lien: LIEN }, BASE);
    expect(texte).toContain('{nom}');
  });
});
