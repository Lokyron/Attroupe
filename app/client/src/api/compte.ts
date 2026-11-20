import { appeler, booleen, champ, liste, nombre, texte, texteOuNul } from './client.js';

// Compte courant : profil, mot de passe, vérification d'adresse et sessions (appareils connectés).
// Aucune route ne reçoit d'identifiant de compte : elles visent toujours celui de la session.

/** Ce que renvoie le serveur après une modification du profil (les champs que l'écran relit). */
export interface ProfilCompte {
  display_name: string;
  time_zone: string;
  /** `null` : adresse non confirmée. */
  email_verified_at: string | null;
}

export interface SessionCompte {
  id: string;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  /** Identification brute du navigateur, absente si l'appareil ne s'est pas présenté. */
  user_agent: string | null;
  /** Vrai pour la session qui fait cette requête : la révoquer reviendrait à se déconnecter soi-même. */
  courante: boolean;
}

function profil(r: unknown): ProfilCompte {
  return {
    display_name: texte(champ(r, 'display_name')),
    time_zone: texte(champ(r, 'time_zone')),
    email_verified_at: texteOuNul(champ(r, 'email_verified_at')),
  };
}

function session(s: unknown): SessionCompte {
  return {
    id: texte(champ(s, 'id')),
    created_at: texte(champ(s, 'created_at')),
    last_seen_at: texte(champ(s, 'last_seen_at')),
    expires_at: texte(champ(s, 'expires_at')),
    user_agent: texteOuNul(champ(s, 'user_agent')),
    courante: booleen(champ(s, 'courante')),
  };
}

/** Au moins un champ est exigé par le serveur ; un champ absent n'est pas touché. */
export async function modifierProfil(champs: { display_name?: string; time_zone?: string }): Promise<ProfilCompte> {
  return profil(await appeler('PATCH', '/api/moi', champs));
}

/** Le serveur renouvelle le cookie de CETTE session et révoque les autres : l'utilisateur reste connecté ici. */
export async function changerMotDePasse(motDePasseActuel: string, nouveauMotDePasse: string): Promise<void> {
  await appeler('POST', '/api/moi/mot-de-passe', { current_password: motDePasseActuel, new_password: nouveauMotDePasse });
}

/** Renvoie le lien de confirmation de l'adresse e-mail (202). */
export async function renvoyerVerificationEmail(): Promise<void> {
  await appeler('POST', '/api/moi/email/verification');
}

export async function listerSessions(): Promise<SessionCompte[]> {
  return liste(champ(await appeler('GET', '/api/moi/sessions'), 'sessions')).map(session);
}

/** Révoque toutes les sessions SAUF la courante ; renvoie le nombre d'appareils déconnectés. */
export async function revoquerAutresSessions(): Promise<number> {
  return nombre(champ(await appeler('DELETE', '/api/moi/sessions'), 'revoquees'));
}

/** 404 `session.introuvable` si la session n'est pas à moi ou n'existe plus. */
export async function revoquerSession(id: string): Promise<void> {
  await appeler('DELETE', `/api/moi/sessions/${encodeURIComponent(id)}`);
}
