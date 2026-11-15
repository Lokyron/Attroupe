import { decor, MOT_DE_PASSE, type Client, type Decor } from './comptes.js';

// Décor des tests du lot 3 : des comptes réels (inscrits, vérifiés, connectés par l'API), des groupes et des
// appartenances amorcés en base, puis tout le reste par l'API. Les identifiants sont ceux de la base.

export const T0 = '2026-11-15T12:00:00Z';

export interface Personne {
  readonly client: Client;
  readonly userId: string;
  readonly email: string;
  readonly username: string;
}

export { decor, MOT_DE_PASSE };

/** Inscrit, VÉRIFIE l'adresse (jeton lu dans l'e-mail remis) et connecte un compte. */
export async function personne(d: Decor, username: string, options: { verifie?: boolean; adresse?: string } = {}): Promise<Personne> {
  const email = `${username.toLowerCase()}@exemple.test`;
  const client = d.client(options.adresse ?? `10.1.${String(d.sql.prepare('SELECT count(*) FROM users').pluck().get() as number)}.1`);
  const inscription = await client.post('/api/auth/inscription', { email, username, password: MOT_DE_PASSE });
  if (inscription.statut !== 202) throw new Error(`Inscription refusée : ${JSON.stringify(inscription.corps)}`);
  if (options.verifie !== false) {
    const jeton = await d.jetonMail(email, 'verification_email');
    const verification = await client.post('/api/auth/email/verification', { token: jeton });
    if (verification.statut !== 200) throw new Error(`Vérification refusée : ${JSON.stringify(verification.corps)}`);
  }
  const connexion = await client.post('/api/auth/connexion', { email, password: MOT_DE_PASSE });
  if (connexion.statut !== 200) throw new Error(`Connexion refusée : ${JSON.stringify(connexion.corps)}`);
  const userId = d.sql.prepare('SELECT id FROM users WHERE lower(username) = lower(?)').pluck().get(username) as string;
  return { client, userId, email, username };
}

export interface GroupeAmorce {
  readonly groupId: string;
  readonly membreIds: ReadonlyMap<string, string>;
}

/**
 * Crée un groupe PAR L'API : le premier de la liste le crée (il en devient administrateur), les autres sont invités par leur nom
 * d'utilisateur exact et acceptent leur invitation, comme dans l'application.
 */
export async function groupe(d: Decor, nom: string, membres: ReadonlyArray<{ personne: Personne; role: 'admin' | 'member' }>): Promise<GroupeAmorce> {
  const [createur, ...autres] = membres;
  if (createur === undefined) throw new Error('Un groupe a au moins un membre.');
  const creation = await createur.personne.client.post('/api/groupes', { name: nom });
  if (creation.statut !== 201) throw new Error(`Création de groupe refusée : ${JSON.stringify(creation.corps)}`);
  const groupId = creation.corps['id'] as string;
  for (const { personne: invite, role } of autres) {
    const emission = await createur.personne.client.post(`/api/groupes/${groupId}/invitations`, { username: invite.username, role });
    if (emission.statut !== 202) throw new Error(`Invitation refusée : ${JSON.stringify(emission.corps)}`);
    const recues = (await invite.client.get('/api/moi/invitations')).corps['invitations'] as Array<{ id: string; group_name: string }>;
    const recue = recues.find((i) => i.group_name === nom);
    if (recue === undefined) throw new Error(`${invite.username} n'a pas reçu l'invitation à « ${nom} ».`);
    const acceptation = await invite.client.post(`/api/moi/invitations/${recue.id}/acceptation`);
    if (acceptation.statut !== 200) throw new Error(`Acceptation refusée : ${JSON.stringify(acceptation.corps)}`);
  }
  const ids = new Map<string, string>();
  for (const { personne: p } of membres) {
    ids.set(p.username, d.sql.prepare('SELECT id FROM memberships WHERE group_id = ? AND user_id = ?').pluck().get(groupId, p.userId) as string);
  }
  return { groupId, membreIds: ids };
}

/** Identifiant de l'appartenance d'une personne dans un groupe amorcé. */
export function membreDe(g: GroupeAmorce, p: Personne): string {
  const id = g.membreIds.get(p.username);
  if (id === undefined) throw new Error(`${p.username} n'est pas membre de ce groupe.`);
  return id;
}
