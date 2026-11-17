import { appeler, booleen, champ, liste, nombre, role, texte, texteOuNul } from './client';

// Les formes de l'API de groupes (architecture §6), relues champ par champ à l'arrivée.

export type Role = 'admin' | 'member';

export interface Moi {
  username: string;
  display_name: string;
  avatar_url: string | null;
  groupes: GroupeResume[];
  invitations_en_attente: number;
  service_email: 'actif' | 'non_configure';
}

export interface GroupeResume {
  group_id: string;
  name: string;
  role: Role;
}

export interface Membre {
  id: string;
  display_name: string;
  avatar_url: string | null;
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
  ma_visibilite_defaut: 'none' | 'busy' | 'details';
  fonctionnalites: {
    photos: boolean;
  };
}

function avatarUrlOptionnel(valeur: unknown): string | null {
  if (typeof valeur !== 'object' || valeur === null || !('avatar_url' in valeur)) return null;
  return texteOuNul((valeur as Record<string, unknown>)['avatar_url']);
}

export async function lireMoi(): Promise<Moi> {
  const r = await appeler('GET', '/api/moi');
  const serviceEmailBrut = champ(r, 'service_email');
  const service_email = serviceEmailBrut === 'actif' ? 'actif' : 'non_configure';
  return {
    username: texte(champ(r, 'username')),
    display_name: texte(champ(r, 'display_name')),
    avatar_url: avatarUrlOptionnel(r),
    groupes: liste(champ(r, 'groupes')).map((g) => ({ group_id: texte(champ(g, 'group_id')), name: texte(champ(g, 'name')), role: role(champ(g, 'role')) })),
    invitations_en_attente: nombre(champ(r, 'invitations_en_attente')),
    service_email,
  };
}

export type MimeAvatar = 'image/webp' | 'image/jpeg' | 'image/png';

/** Recadre un fichier image au centre en carré 256×256 et l'encode en base64 (WebP ou repli JPEG). */
export async function preparerImageAvatar(fichier: File): Promise<{ mime: 'image/webp' | 'image/jpeg'; data_base64: string }> {
  const url = URL.createObjectURL(fichier);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error('avatar.invalide'));
      element.src = url;
    });
    if (img.naturalWidth === 0 || img.naturalHeight === 0) throw new Error('avatar.invalide');
    const cote = Math.min(img.naturalWidth, img.naturalHeight);
    const sx = Math.floor((img.naturalWidth - cote) / 2);
    const sy = Math.floor((img.naturalHeight - cote) / 2);
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    if (ctx === null) throw new Error('avatar.invalide');
    ctx.drawImage(img, sx, sy, cote, cote, 0, 0, 256, 256);

    const webp = canvas.toDataURL('image/webp', 0.85);
    const prefixeWebp = 'data:image/webp;base64,';
    if (webp.startsWith(prefixeWebp)) {
      return { mime: 'image/webp', data_base64: webp.slice(prefixeWebp.length) };
    }
    const jpeg = canvas.toDataURL('image/jpeg', 0.85);
    const prefixeJpeg = 'data:image/jpeg;base64,';
    if (jpeg.startsWith(prefixeJpeg)) {
      return { mime: 'image/jpeg', data_base64: jpeg.slice(prefixeJpeg.length) };
    }
    throw new Error('avatar.invalide');
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function enregistrerAvatar(mime: MimeAvatar, dataBase64: string): Promise<string> {
  const r = await appeler('PUT', '/api/moi/avatar', { mime, data_base64: dataBase64 });
  return texte(champ(r, 'avatar_url'));
}

export async function supprimerAvatar(): Promise<void> {
  await appeler('DELETE', '/api/moi/avatar');
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
  const vis = champ(r, 'ma_visibilite_defaut');
  const maVisibilite = vis === 'none' || vis === 'busy' || vis === 'details' ? vis : 'busy';
  const fonct = champ(r, 'fonctionnalites');
  return {
    id: texte(champ(r, 'id')),
    name: texte(champ(r, 'name')),
    default_currency_code: texte(champ(r, 'default_currency_code')),
    time_zone: texte(champ(r, 'time_zone')),
    mon_role: role(champ(r, 'mon_role')),
    mon_appartenance_id: texte(champ(r, 'mon_appartenance_id')),
    ma_visibilite_defaut: maVisibilite,
    fonctionnalites: {
      photos: booleen(champ(fonct, 'photos')),
    },
  };
}

export async function listerMembres(groupId: string): Promise<Membre[]> {
  const r = await appeler('GET', `/api/groupes/${encodeURIComponent(groupId)}/membres`);
  return liste(champ(r, 'membres')).map((m) => {
    const status = champ(m, 'status');
    if (status !== 'active' && status !== 'removed' && status !== 'left') throw new Error('Statut de membre inconnu.');
    return {
      id: texte(champ(m, 'id')),
      display_name: texte(champ(m, 'display_name')),
      avatar_url: avatarUrlOptionnel(m),
      role: role(champ(m, 'role')),
      status,
    };
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
