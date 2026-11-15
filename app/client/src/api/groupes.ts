import { appeler, champ, liste, nombre, role, texte, texteOuNul } from './client';

// Les formes de l'API de groupes (architecture §6), relues champ par champ à l'arrivée.

export type Role = 'admin' | 'member';

export interface Moi {
  username: string;
  display_name: string;
  groupes: GroupeResume[];
  invitations_en_attente: number;
}

export interface GroupeResume {
  group_id: string;
  name: string;
  role: Role;
}

export interface Membre {
  id: string;
  display_name: string;
  role: Role;
  status: 'active' | 'removed' | 'left';
}

export interface InvitationEmise {
  id: string;
  kind: 'email' | 'existing_user';
  email: string | null;
  username: string | null;
  role: Role;
  status: string;
  expires_at: string;
}

export interface InvitationRecue {
  id: string;
  group_name: string;
  invited_by_name: string;
  role: Role;
  message: string | null;
  expires_at: string;
}

export interface Apercu {
  group_name: string;
  invited_by_name: string;
  role: Role;
}

export interface DetailGroupe {
  id: string;
  name: string;
  default_currency_code: string;
  time_zone: string;
  mon_role: Role;
  mon_appartenance_id: string;
}

export async function lireMoi(): Promise<Moi> {
  const r = await appeler('GET', '/api/moi');
  return {
    username: texte(champ(r, 'username')),
    display_name: texte(champ(r, 'display_name')),
    groupes: liste(champ(r, 'groupes')).map((g) => ({ group_id: texte(champ(g, 'group_id')), name: texte(champ(g, 'name')), role: role(champ(g, 'role')) })),
    invitations_en_attente: nombre(champ(r, 'invitations_en_attente')),
  };
}

export async function connecter(email: string, password: string): Promise<void> {
  await appeler('POST', '/api/auth/connexion', { email, password });
}

export async function inscrire(email: string, username: string, password: string): Promise<void> {
  await appeler('POST', '/api/auth/inscription', { email, username, password });
}

export async function deconnecter(): Promise<void> {
  await appeler('POST', '/api/auth/deconnexion', {});
}

export async function creerGroupe(name: string): Promise<string> {
  return texte(champ(await appeler('POST', '/api/groupes', { name }), 'id'));
}

export async function lireGroupe(groupId: string): Promise<DetailGroupe> {
  const r = await appeler('GET', `/api/groupes/${encodeURIComponent(groupId)}`);
  return {
    id: texte(champ(r, 'id')),
    name: texte(champ(r, 'name')),
    default_currency_code: texte(champ(r, 'default_currency_code')),
    time_zone: texte(champ(r, 'time_zone')),
    mon_role: role(champ(r, 'mon_role')),
    mon_appartenance_id: texte(champ(r, 'mon_appartenance_id')),
  };
}

export async function listerMembres(groupId: string): Promise<Membre[]> {
  const r = await appeler('GET', `/api/groupes/${encodeURIComponent(groupId)}/membres`);
  return liste(champ(r, 'membres')).map((m) => {
    const status = champ(m, 'status');
    if (status !== 'active' && status !== 'removed' && status !== 'left') throw new Error('Statut de membre inconnu.');
    return { id: texte(champ(m, 'id')), display_name: texte(champ(m, 'display_name')), role: role(champ(m, 'role')), status };
  });
}

export async function changerRole(groupId: string, membreId: string, nouveau: Role): Promise<void> {
  await appeler('PATCH', `/api/groupes/${encodeURIComponent(groupId)}/membres/${encodeURIComponent(membreId)}`, { role: nouveau });
}

export async function retirerMembre(groupId: string, membreId: string): Promise<void> {
  await appeler('DELETE', `/api/groupes/${encodeURIComponent(groupId)}/membres/${encodeURIComponent(membreId)}`);
}

export async function quitterGroupe(groupId: string): Promise<void> {
  await appeler('POST', `/api/groupes/${encodeURIComponent(groupId)}/depart`, {});
}

export async function listerInvitationsEmises(groupId: string): Promise<InvitationEmise[]> {
  const r = await appeler('GET', `/api/groupes/${encodeURIComponent(groupId)}/invitations`);
  return liste(champ(r, 'invitations')).map((i) => {
    const kind = champ(i, 'kind');
    if (kind !== 'email' && kind !== 'existing_user') throw new Error("Nature d'invitation inconnue.");
    return {
      id: texte(champ(i, 'id')),
      kind,
      email: texteOuNul(champ(i, 'email')),
      username: texteOuNul(champ(i, 'username')),
      role: role(champ(i, 'role')),
      status: texte(champ(i, 'status')),
      expires_at: texte(champ(i, 'expires_at')),
    };
  });
}

export async function inviter(groupId: string, cible: { email: string } | { username: string }, roleInvite: Role): Promise<void> {
  await appeler('POST', `/api/groupes/${encodeURIComponent(groupId)}/invitations`, { ...cible, role: roleInvite });
}

export async function revoquerInvitation(groupId: string, invitationId: string): Promise<void> {
  await appeler('DELETE', `/api/groupes/${encodeURIComponent(groupId)}/invitations/${encodeURIComponent(invitationId)}`);
}

export async function listerInvitationsRecues(): Promise<InvitationRecue[]> {
  const r = await appeler('GET', '/api/moi/invitations');
  return liste(champ(r, 'invitations')).map((i) => ({
    id: texte(champ(i, 'id')),
    group_name: texte(champ(i, 'group_name')),
    invited_by_name: texte(champ(i, 'invited_by_name')),
    role: role(champ(i, 'role')),
    message: texteOuNul(champ(i, 'message')),
    expires_at: texte(champ(i, 'expires_at')),
  }));
}

export async function repondreInvitation(invitationId: string, reponse: 'acceptation' | 'refus'): Promise<void> {
  await appeler('POST', `/api/moi/invitations/${encodeURIComponent(invitationId)}/${reponse}`, {});
}

export async function apercuLien(jeton: string): Promise<Apercu> {
  const r = await appeler('POST', '/api/invitations/apercu', { token: jeton });
  return { group_name: texte(champ(r, 'group_name')), invited_by_name: texte(champ(r, 'invited_by_name')), role: role(champ(r, 'role')) };
}

export async function accepterLien(jeton: string): Promise<void> {
  await appeler('POST', '/api/invitations/acceptation', { token: jeton });
}
