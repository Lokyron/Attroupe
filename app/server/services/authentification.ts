import {
  changerMotDePasse as changerMotDePasseEnBase,
  chercherCompteActifParEmail,
  creerCompte,
  creerSession,
  demanderReinitialisation as demanderReinitialisationEnBase,
  demanderVerification,
  jetonReinitialisationValide,
  lireEmpreinteMotDePasse,
  lireProfil,
  prouverParMotDePasse,
  reinitialiserMotDePasse,
  remplacerEmpreinteMotDePasse,
  verifierEmailParJeton,
} from '../db/queries/comptes.js';
import { evaluerMotDePasse } from '../domain/mot-de-passe.js';
import { depuisInstant, versInstant } from '../domain/instant.js';
import { empreinteJeton, nouveauJeton } from '../domain/jetons.js';
import { echeanceSession } from '../domain/session.js';
import type { Contexte } from '../http/contexte.js';
import { ErreurHttp } from '../http/erreurs.js';
import type { Authentification } from '../http/middleware/session.js';
import { emailCompteExistant, emailReinitialisation, emailVerification } from './emails.js';
import { doitEtreRehache, empreinteLeurre, hacher, verifier } from './mot-de-passe.js';

// Cas d'usage d'authentification. Les routes (http/routes/auth.ts) valident l'entrée et posent le cookie ;
// la règle métier — et surtout l'ABSENCE d'énumération de comptes — vit ici, en un seul endroit.
//
// Principe d'indistinguabilité : pour un attaquant, « l'adresse existe » et « elle n'existe pas » donnent la
// même réponse (statut, corps) ET à peu près la même durée :
//  - connexion : le mot de passe est toujours vérifié (contre une empreinte leurre si le compte n'existe pas) ;
//  - inscription : le mot de passe est toujours haché avant de regarder si l'adresse est prise ;
//  - mot de passe oublié : la réponse attend une durée minimale fixe, quel que soit le travail fait.
// Seule exception voulue : un nom d'utilisateur déjà pris se dit (409), parce que le nom d'utilisateur est
// public par conception (ajout d'un membre par nom exact, modèle de données §3.2) ; ce refus ne dépend jamais
// de l'adresse e-mail.

export interface EntreeInscription {
  readonly email: string;
  readonly username: string;
  readonly display_name: string | undefined;
  readonly password: string;
}

export async function inscrire(contexte: Contexte, entree: EntreeInscription): Promise<void> {
  if (contexte.env.ATTROUPE_REGISTRATION === 'invite') throw new ErreurHttp(403, 'inscription.fermee');

  const partieLocale = entree.email.split('@')[0] ?? '';
  const refus = evaluerMotDePasse(entree.password, { identifiants: [entree.username, partieLocale] });
  if (refus !== undefined) throw new ErreurHttp(400, refus);

  // Toujours haché, que l'adresse soit libre ou non : même coût dans les deux cas.
  const hachage = await hacher(entree.password, contexte.parametresScrypt);
  const maintenant = contexte.horloge();
  const baseUrl = contexte.env.ATTROUPE_BASE_URL;

  const resultat = creerCompte(
    contexte.base,
    {
      email: entree.email,
      username: entree.username,
      display_name: entree.display_name ?? entree.username,
      password_hash: hachage,
      // Le lien à jeton se fabrique à l'envoi (services/brevo.ts) : la file ne reçoit que l'identifiant de la ligne de jeton.
      emailVerification: (jetonId) => emailVerification(entree.email, entree.display_name ?? entree.username, jetonId),
      emailCompteExistant: (nom) => emailCompteExistant(baseUrl, entree.email, nom),
    },
    versInstant(maintenant),
  );
  if (resultat === 'nom_utilisateur_pris') throw new ErreurHttp(409, 'nom_utilisateur.pris');
  // 'cree' et 'email_deja_inscrit' : même suite, même réponse.
}

export function verifierEmail(contexte: Contexte, jeton: string): void {
  if (!verifierEmailParJeton(contexte.base, empreinteJeton(jeton), versInstant(contexte.horloge()))) {
    throw new ErreurHttp(400, 'jeton.invalide');
  }
}

export interface MetaConnexion {
  readonly userAgent: string | null;
  readonly ipHash: string | null;
}

export interface SessionOuverte {
  readonly jeton: string;
  readonly expireLe: Date;
}

export async function connecter(contexte: Contexte, email: string, motDePasse: string, meta: MetaConnexion): Promise<SessionOuverte> {
  const compte = chercherCompteActifParEmail(contexte.base, email);
  // Compte absent, suspendu ou sans mot de passe : la vérification a lieu quand même (contre le leurre, durée
  // comparable) et ne délivre aucune preuve. Seule une preuve ouvre une session.
  const preuve = await prouverParMotDePasse(compte, motDePasse, await empreinteLeurre(contexte.parametresScrypt));
  if (preuve === undefined) throw new ErreurHttp(401, 'auth.identifiants_invalides');

  const maintenant = contexte.horloge();
  // Les paramètres de hachage ont durci depuis la création du compte : on profite du mot de passe en clair pour refaire l'empreinte.
  if (doitEtreRehache(preuve.password_hash, contexte.parametresScrypt)) {
    remplacerEmpreinteMotDePasse(contexte.base, preuve, await hacher(motDePasse, contexte.parametresScrypt), versInstant(maintenant));
  }
  const jeton = nouveauJeton();
  const expireLe = echeanceSession(maintenant, maintenant);
  creerSession(contexte.base, preuve, {
    empreinte: empreinteJeton(jeton),
    maintenant: versInstant(maintenant),
    expireLe: versInstant(expireLe),
    userAgent: meta.userAgent,
    ipHash: meta.ipHash,
  });
  return { jeton, expireLe };
}

function attendre(ms: number): Promise<void> {
  return new Promise((resoudre) => setTimeout(resoudre, ms));
}

/** Met un e-mail de réinitialisation en file SI le compte existe ; ne dit jamais s'il existe (durée minimale fixe). */
export async function demanderReinitialisation(contexte: Contexte, email: string): Promise<void> {
  const debut = performance.now();
  demanderReinitialisationEnBase(contexte.base, email, versInstant(contexte.horloge()), (nom, jetonId) =>
    emailReinitialisation(email, nom, jetonId),
  );
  const reste = contexte.delaiMinimalOubliMs - (performance.now() - debut);
  if (reste > 0) await attendre(reste);
}

export async function reinitialiser(contexte: Contexte, jeton: string, motDePasse: string): Promise<void> {
  const refus = evaluerMotDePasse(motDePasse);
  if (refus !== undefined) throw new ErreurHttp(400, refus);
  const empreinte = empreinteJeton(jeton);
  // Lecture seule d'abord : un jeton inconnu ne coûte pas un hachage scrypt de 32 Mio.
  if (!jetonReinitialisationValide(contexte.base, empreinte, versInstant(contexte.horloge()))) throw new ErreurHttp(400, 'jeton.invalide');
  const hachage = await hacher(motDePasse, contexte.parametresScrypt);
  // Consommation atomique (usage unique) : si deux requêtes se croisent, une seule réussit. Le temps du hachage a pu
  // laisser le jeton expirer ; l'heure est relue pour la consommation.
  if (!reinitialiserMotDePasse(contexte.base, empreinte, hachage, versInstant(contexte.horloge()))) throw new ErreurHttp(400, 'jeton.invalide');
}

/**
 * Change le mot de passe du compte connecté : ancien mot de passe vérifié, nouveau posé, AUTRES sessions révoquées et
 * jeton de la session courante renouvelé (l'ancien cookie ne vaut plus rien), en une transaction. Renvoie le nouveau
 * jeton, que la route dépose en cookie.
 */
export async function changerMotDePasse(contexte: Contexte, auth: Authentification, ancien: string, nouveau: string): Promise<SessionOuverte> {
  const profil = lireProfil(auth.portee);
  const refus = evaluerMotDePasse(nouveau, { identifiants: [profil.username, profil.email.split('@')[0] ?? ''] });
  if (refus !== undefined) throw new ErreurHttp(400, refus);

  // Compte sans mot de passe (connexion externe, V2) : il n'y a pas d'« ancien » à fournir, même réponse qu'un mauvais mot de passe.
  const ancienneEmpreinte = lireEmpreinteMotDePasse(auth.portee);
  if (ancienneEmpreinte === null || !(await verifier(ancien, ancienneEmpreinte))) throw new ErreurHttp(400, 'mot_de_passe.actuel_invalide');
  if (ancien === nouveau) throw new ErreurHttp(400, 'mot_de_passe.identique');

  const nouvelleEmpreinte = await hacher(nouveau, contexte.parametresScrypt);
  const maintenant = contexte.horloge();
  const jeton = nouveauJeton();
  const expireLe = echeanceSession(depuisInstant(auth.createdAt), maintenant);
  const change = changerMotDePasseEnBase(
    auth.portee,
    auth.sessionId,
    { ancienneEmpreinte, nouvelleEmpreinte, empreinteSession: empreinteJeton(jeton), expireLe: versInstant(expireLe) },
    versInstant(maintenant),
  );
  // Le mot de passe a changé entre la vérification et l'écriture (deux changements simultanés), ou la session vient d'être révoquée.
  if (!change) throw new ErreurHttp(409, 'mot_de_passe.conflit');
  return { jeton, expireLe };
}

/** Renvoie le mail de vérification d'adresse du compte connecté (un lien expiré ne se rattrape pas autrement). */
export function renvoyerVerification(contexte: Contexte, auth: Authentification): void {
  const resultat = demanderVerification(auth.portee, versInstant(contexte.horloge()), (adresse, nom, jetonId) =>
    emailVerification(adresse, nom, jetonId),
  );
  if (resultat === 'deja_verifie') throw new ErreurHttp(409, 'email.deja_verifie');
}
