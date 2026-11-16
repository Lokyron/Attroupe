import type { Decor } from '../fixtures/comptes.js';
import { decor, groupe, membreDe, personne, type GroupeAmorce, type Personne } from '../fixtures/groupes.js';
import type { Ressource } from './registre.js';

// Le décor de la suite de cloisonnement : DEUX groupes étanches, chacun avec son administrateur, ses membres et un
// exemplaire de chaque ressource (architecture §8, `deuxGroupes()`), mais avec de vrais comptes et de vraies sessions.
//
//   Groupe A : Alice (administratrice, l'ATTAQUANTE), Carole (membre, cible des ressources « membre »), Erin (membre sans droit),
//              Manon (administratrice de A ET simple membre de B : l'attaquante MULTI-GROUPES)
//   Groupe B : Bob (administrateur), Dave (membre, ressource « membre » de B), Manon (membre)
//
// Alice n'a AUCUN lien avec B : tout ce qu'elle obtient de B est une fuite. Manon, elle, EST légitimement dans B : un service qui
// demande « l'utilisateur a-t-il accès au groupe de la ressource ? » au lieu de « la ressource est-elle du groupe de l'URL ? »
// l'enverrait chez B sans broncher — Alice, non membre de B, n'attraperait jamais ce défaut.

export interface Monde {
  readonly d: Decor;
  readonly alice: Personne;
  readonly bob: Personne;
  readonly carole: Personne;
  readonly dave: Personne;
  readonly erin: Personne;
  readonly manon: Personne;
  /** Administrateur d'un troisième groupe C, qui invite Alice et Bob (invitations reçues). */
  readonly frank: Personne;
  readonly a: GroupeAmorce;
  readonly b: GroupeAmorce;
  /** L'identifiant de chaque ressource, dans A (celle d'Alice) et dans B (celle qu'elle tente de forger). */
  readonly ressources: Readonly<Record<'a' | 'b', Readonly<Record<Ressource, string>>>>;
  /** Tout ce qui identifie B : aucun de ces textes ne doit apparaître dans une réponse faite à Alice. */
  readonly marquesDeB: readonly string[];
}

async function idSession(p: Personne): Promise<string> {
  const r = await p.client.get('/api/moi/sessions');
  const courante = (r.corps['sessions'] as Array<{ id: string; courante: boolean }>).find((s) => s.courante);
  if (courante === undefined) throw new Error('Session courante introuvable.');
  return courante.id;
}

async function idInvitation(admin: Personne, g: GroupeAmorce, email: string): Promise<string> {
  const emission = await admin.client.post(`/api/groupes/${g.groupId}/invitations`, { email });
  if (emission.statut !== 202) throw new Error(`Invitation refusée : ${JSON.stringify(emission.corps)}`);
  const liste = (await admin.client.get(`/api/groupes/${g.groupId}/invitations`)).corps['invitations'] as Array<{ id: string; email: string | null }>;
  const trouvee = liste.find((i) => i.email === email);
  if (trouvee === undefined) throw new Error('Invitation émise introuvable dans la liste.');
  return trouvee.id;
}

export async function monde(): Promise<Monde> {
  const d = decor();
  const alice = await personne(d, 'alice_m');
  const bob = await personne(d, 'bob_m');
  const carole = await personne(d, 'carole_m');
  const dave = await personne(d, 'dave_m');
  const erin = await personne(d, 'erin_m');
  const manon = await personne(d, 'manon_m');
  const frank = await personne(d, 'frank_m');
  const a = await groupe(d, 'Groupe A', [
    { personne: alice, role: 'admin' },
    { personne: carole, role: 'member' },
    { personne: erin, role: 'member' },
    { personne: manon, role: 'admin' },
  ]);
  const b = await groupe(d, 'Groupe B secret', [
    { personne: bob, role: 'admin' },
    { personne: dave, role: 'member' },
    { personne: manon, role: 'member' },
  ]);
  const invitationA = await idInvitation(alice, a, 'invite-a@exemple.test');
  const invitationB = await idInvitation(bob, b, 'invite-b@exemple.test');
  // Groupe C : Frank invite Alice et Bob, chacun par son nom d'utilisateur (invitation reçue) ET par son adresse (lien).
  const c = await groupe(d, 'Groupe C', [{ personne: frank, role: 'admin' }]);
  const recue = async (p: Personne): Promise<{ invitationRecue: string; jeton: string }> => {
    for (const corps of [{ username: p.username }, { email: p.email }]) {
      const emission = await frank.client.post(`/api/groupes/${c.groupId}/invitations`, corps);
      if (emission.statut !== 202) throw new Error(`Invitation refusée : ${JSON.stringify(emission.corps)}`);
    }
    const liste = (await p.client.get('/api/moi/invitations')).corps['invitations'] as Array<{ id: string }>;
    const premiere = liste[0];
    if (premiere === undefined) throw new Error(`${p.username} n'a reçu aucune invitation.`);
    return { invitationRecue: premiere.id, jeton: await d.jetonMail(p.email, 'invitation_groupe') };
  };
  // Un événement dans chaque monde (agenda, lot 4) : Alice est l'auteure de celui de A, Bob de celui de B. Erin (simple membre de A,
  // ni auteure ni co-organisatrice) n'a donc aucun droit de modification dessus.
  const evenement = async (auteur: Personne, g: GroupeAmorce, title: string): Promise<string> => {
    const r = await auteur.client.post(`/api/groupes/${g.groupId}/evenements`, { title, starts_at: '2027-03-20T18:00:00Z', time_zone: 'Europe/Paris' });
    if (r.statut !== 201) throw new Error(`Événement refusé : ${JSON.stringify(r.corps)}`);
    return r.corps['id'] as string;
  };
  const evenementA = await evenement(alice, a, 'Soirée du groupe A');
  const evenementB = await evenement(bob, b, 'Soirée du groupe B secret');
  // Carole (simple membre de A, ni administratrice ni auteure) est co-organisatrice de l'événement de A : c'est elle qui prouve
  // qu'une route `organisateur` s'ouvre vraiment à un co-organisateur et pas seulement à un administrateur.
  const coOrganisatrice = await alice.client.post(`/api/groupes/${a.groupId}/evenements/${evenementA}/organisateurs/${membreDe(a, carole)}`);
  if (coOrganisatrice.statut !== 200) throw new Error(`Co-organisatrice refusée : ${JSON.stringify(coOrganisatrice.corps)}`);
  const recueA = await recue(alice);
  const recueB = await recue(bob);
  const ressources = {
    a: { membre: membreDe(a, carole), evenement: evenementA, invitation: invitationA, session: await idSession(alice), ...recueA },
    b: { membre: membreDe(b, dave), evenement: evenementB, invitation: invitationB, session: await idSession(bob), ...recueB },
  };
  const marquesDeB = [
    b.groupId,
    'Groupe B secret',
    bob.userId,
    dave.userId,
    bob.email,
    dave.email,
    bob.username,
    dave.username,
    'invite-b@exemple.test',
    'Soirée du groupe B secret',
    ...Object.values(ressources.b),
  ];
  return { d, alice, bob, carole, dave, erin, manon, frank, a, b, ressources, marquesDeB };
}
