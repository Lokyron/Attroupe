import type { Request } from 'express';
import { describe, expect, it } from 'vitest';
import { adresseClient, reseauClient } from '../../server/http/middleware/cadence.js';
import { MINUTE_MS } from '../../server/domain/instant.js';
import { LimiteurCadence, type RegleCadence } from '../../server/services/cadence.js';
import { horlogeTest } from '../fixtures/comptes.js';

const REGLE: RegleCadence = { max: 3, fenetreMs: 15 * MINUTE_MS };
const cle = (c: string): Array<{ cle: string; regle: RegleCadence }> => [{ cle: c, regle: REGLE }];

describe('limiteur de cadence', () => {
  it('laisse passer N tentatives puis refuse la suivante avec un délai', () => {
    const t = horlogeTest();
    const l = new LimiteurCadence(t.horloge);
    for (let i = 0; i < 3; i++) expect(l.tenter(cle('a')).autorise).toBe(true);
    const verdict = l.tenter(cle('a'));
    expect(verdict).toEqual({ autorise: false, retryApresSecondes: 15 * 60 });
  });

  it('se relâche une fois le blocage écoulé', () => {
    const t = horlogeTest();
    const l = new LimiteurCadence(t.horloge);
    for (let i = 0; i < 4; i++) l.tenter(cle('a'));
    t.avancer(14 * MINUTE_MS);
    expect(l.tenter(cle('a')).autorise).toBe(false);
    t.avancer(2 * MINUTE_MS);
    expect(l.tenter(cle('a')).autorise).toBe(true);
  });

  it('double le blocage à chaque récidive (report exponentiel), jusqu’au plafond', () => {
    const t = horlogeTest();
    const l = new LimiteurCadence(t.horloge);
    const blocages: number[] = [];
    for (let tour = 0; tour < 7; tour++) {
      let v = l.tenter(cle('a'));
      while (v.autorise) v = l.tenter(cle('a'));
      blocages.push(v.retryApresSecondes);
      t.avancer(v.retryApresSecondes * 1000 + 1000);
    }
    expect(blocages.slice(0, 4)).toEqual([900, 1800, 3600, 7200]);
    expect(Math.max(...blocages)).toBeLessThanOrEqual(12 * 3600);
  });

  it('une fenêtre sans excès remet le compteur à zéro', () => {
    const t = horlogeTest();
    const l = new LimiteurCadence(t.horloge);
    for (let i = 0; i < 3; i++) l.tenter(cle('a'));
    t.avancer(16 * MINUTE_MS);
    for (let i = 0; i < 3; i++) expect(l.tenter(cle('a')).autorise).toBe(true);
  });

  it('les clés sont indépendantes ; débiter plusieurs clés bloque sur la plus longue', () => {
    const t = horlogeTest();
    const l = new LimiteurCadence(t.horloge);
    for (let i = 0; i < 4; i++) l.tenter(cle('ip:1'));
    expect(l.tenter(cle('ip:2')).autorise).toBe(true);
    const deux = l.tenter([...cle('ip:2'), ...cle('ip:1')]);
    expect(deux.autorise).toBe(false);
  });

  it('oublier remet une clé à zéro', () => {
    const l = new LimiteurCadence(horlogeTest().horloge);
    for (let i = 0; i < 4; i++) l.tenter(cle('a'));
    l.oublier('a');
    expect(l.tenter(cle('a')).autorise).toBe(true);
  });

  it('la table est bornée : des clés inventées à volonté ne font pas gonfler la mémoire', () => {
    const l = new LimiteurCadence(horlogeTest().horloge);
    for (let i = 0; i < 60_000; i++) l.tenter(cle(`k${String(i)}`));
    expect(l.taille).toBeLessThanOrEqual(50_000);
  });
});

describe('limiteur de cadence : tenir un blocage jusqu’au plafond de clés', () => {
  const COUPLE: RegleCadence = { max: 10, fenetreMs: 15 * MINUTE_MS };
  const EMAIL_LARGE: RegleCadence = { max: 100, fenetreMs: 15 * MINUTE_MS };
  const PAR_IP: RegleCadence = { max: 30, fenetreMs: 15 * MINUTE_MS };
  /** Les clés que le garde de la connexion débite pour (email, ip) : couple, e-mail seul, IP. */
  const connexion = (email: string, ip: string): Array<{ cle: string; regle: RegleCadence }> => [
    { cle: `ip:${ip}`, regle: PAR_IP },
    { cle: `couple:${email}|${ip}`, regle: COUPLE },
    { cle: `email:${email}`, regle: EMAIL_LARGE },
  ];

  it('un blocage en cours ne crée aucune clé : les requêtes refusées ne coûtent rien à la table', () => {
    const l = new LimiteurCadence(horlogeTest().horloge);
    for (let i = 0; i < 31; i++) l.tenter(connexion(`cible${String(i)}@x`, '192.0.2.1')); // le 31e ouvre le blocage de l'IP
    const taille = l.taille;
    for (let i = 0; i < 1000; i++) expect(l.tenter(connexion(`aleatoire${String(i)}@x`, '192.0.2.1')).autorise).toBe(false);
    expect(l.taille).toBe(taille);
  });

  it('scénario du reviewer : saturer sa propre table ne relâche pas le blocage d’une autre IP sur la victime', () => {
    const l = new LimiteurCadence(horlogeTest().horloge);
    // L'IP n° 2 épuise ses 10 essais sur la victime : le 11e est refusé.
    for (let i = 0; i < 10; i++) expect(l.tenter(connexion('victime@x', '192.0.2.2')).autorise).toBe(true);
    expect(l.tenter(connexion('victime@x', '192.0.2.2')).autorise).toBe(false);
    // L'IP n° 1 envoie 50 000 requêtes avec des adresses aléatoires.
    for (let i = 0; i < 50_000; i++) l.tenter(connexion(`aleatoire${String(i)}@x`, '192.0.2.1'));
    expect(l.taille).toBeLessThan(200); // 30 essais admis puis plus rien de créé
    // L'IP n° 2 repart : elle n'a pas regagné un seul essai (avant le correctif : 40 de plus).
    let acceptes = 0;
    for (let i = 0; i < 50; i++) if (l.tenter(connexion('victime@x', '192.0.2.2')).autorise) acceptes++;
    expect(acceptes).toBe(0);
  });

  it('au plafond de clés, une clé bloquée n’est JAMAIS évincée (même la plus ancienne), les clés libres le sont', () => {
    const t = horlogeTest();
    const l = new LimiteurCadence(t.horloge);
    // La clé bloquée est la plus ancienne de la table : c'est celle que l'ancienne éviction oubliait en premier.
    for (let i = 0; i < 11; i++) l.tenter(cle('bloquee'));
    expect(l.tenter(cle('bloquee')).autorise).toBe(false);
    // Une table pleine de clés vivantes (chacune à son premier essai, d'adresses distinctes).
    for (let i = 0; i < 60_000; i++) l.tenter([{ cle: `vivante${String(i)}`, regle: COUPLE }]);
    expect(l.taille).toBeLessThanOrEqual(50_000);
    expect(l.tenter([{ cle: 'bloquee', regle: COUPLE }]).autorise).toBe(false);
  });

  it('table pleine de blocages en cours : la requête est refusée plutôt que d’oublier un blocage', () => {
    const l = new LimiteurCadence(horlogeTest().horloge);
    const bloque: RegleCadence = { max: 0, fenetreMs: 15 * MINUTE_MS }; // le premier essai ouvre déjà un blocage
    for (let i = 0; i < 50_000; i++) l.tenter([{ cle: `b${String(i)}`, regle: bloque }]);
    expect(l.taille).toBe(50_000);
    const verdict = l.tenter([{ cle: 'nouvelle', regle: COUPLE }]);
    expect(verdict).toEqual({ autorise: false, retryApresSecondes: 60 });
    expect(l.taille).toBe(50_000);
    expect(l.tenter([{ cle: 'b0', regle: bloque }]).autorise).toBe(false); // le tout premier blocage tient toujours
  });

  it('rembourser annule le débit de la tentative, une seule fois', () => {
    const l = new LimiteurCadence(horlogeTest().horloge);
    for (let i = 0; i < 3; i++) {
      const v = l.tenter(cle('a'));
      if (!v.autorise) throw new Error('refus inattendu');
      v.rembourser();
      v.rembourser(); // sans effet au deuxième appel
    }
    for (let i = 0; i < 3; i++) expect(l.tenter(cle('a')).autorise).toBe(true); // 3 essais intacts
    expect(l.tenter(cle('a')).autorise).toBe(false);
  });
});

describe('adresse du client', () => {
  const de = (ip: string | undefined): string => adresseClient({ ip } as Request);

  it('ramène une IPv4 mappée en IPv6 à l’IPv4', () => {
    expect(de('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(de('203.0.113.7')).toBe('203.0.113.7');
  });

  it('ramène toute IPv6 d’un même /64 à la même clé : changer les 64 derniers bits ne contourne pas la limite', () => {
    const a = de('2001:db8:1:2:aaaa:bbbb:cccc:dddd');
    expect(de('2001:db8:1:2::1')).toBe(a);
    expect(de('2001:DB8:1:2:0:0:0:ffff')).toBe(a);
    expect(de('2001:db8:1:3::1')).not.toBe(a);
    expect(de('::1')).toBe('0000:0000:0000:0000::/64');
  });

  it('le préfixe /48 regroupe les /64 d’un même site, et n’existe pas pour une IPv4', () => {
    const r = (ip: string): string | undefined => reseauClient({ ip } as Request);
    expect(r('2001:db8:abcd:1::1')).toBe('2001:0db8:abcd::/48');
    expect(r('2001:db8:abcd:ffff:1:2:3:4')).toBe(r('2001:db8:abcd:1::1'));
    expect(r('2001:db8:abce:1::1')).not.toBe(r('2001:db8:abcd:1::1'));
    expect(r('203.0.113.7')).toBeUndefined();
    expect(r('::ffff:203.0.113.7')).toBeUndefined();
  });

  it('tolère une adresse absente', () => {
    expect(de(undefined)).toBe('inconnue');
  });
});
