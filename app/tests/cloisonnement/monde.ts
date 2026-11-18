import type { Decor } from '../fixtures/comptes.js';
import { decor, groupe, membreDe, personne, type GroupeAmorce, type Personne } from '../fixtures/groupes.js';
import { agendaEnMemoire } from '../fixtures/faux-agenda.js';
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

/** Un abonnement calendrier créé par l'API : son identifiant et le jeton en clair (rendu une seule fois, ici). */
export interface JetonCree {
  readonly id: string;
  readonly jeton: string;
}

/**
 * Les jetons du flux iCal (lot 5). Les attaquantes sont de SIMPLES MEMBRES (Erin, Dave) ou Manon (membre de A et B) : au lot 4, une exigence
 * dont toutes les attaquantes étaient administratrices ne protégeait rien. Alice (administratrice) n'a qu'un jeton « propre » pour la route
 * de révocation.
 */
export interface JetonsFlux {
  readonly erin: JetonCree;
  readonly erinRestreintA: JetonCree;
  readonly dave: JetonCree;
  readonly manonTous: JetonCree;
  readonly manonRestreintA: JetonCree;
  readonly manonRestreintB: JetonCree;
}

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
  /** Les jetons de flux iCal du décor. */
  readonly flux: JetonsFlux;
}

async function creerFlux(p: Personne, corps: Record<string, unknown>): Promise<JetonCree> {
  const r = await p.client.post('/api/moi/flux-ical', corps);
  if (r.statut !== 201) throw new Error(`Abonnement refusé : ${JSON.stringify(r.corps)}`);
  return { id: r.corps['id'] as string, jeton: r.corps['token'] as string };
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
  let compteurImmich = 0;
  const assetsParAlbum = new Map<string, string[]>();
  const fetchImmich = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const methode = (init?.method ?? 'GET').toUpperCase();
    const chemin = new URL(url).pathname.replace(/^\/api/, '');
    if (methode === 'GET' && chemin === '/users/me') {
      return new Response(JSON.stringify({ id: 'immich-user-1' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (methode === 'POST' && chemin === '/albums') {
      compteurImmich += 1;
      const id = `immich-album-${compteurImmich}`;
      assetsParAlbum.set(id, []);
      return new Response(JSON.stringify({ id }), { status: 201, headers: { 'content-type': 'application/json' } });
    }
    if (methode === 'GET' && chemin.startsWith('/albums/')) {
      const albumId = chemin.slice('/albums/'.length);
      const assets = (assetsParAlbum.get(albumId) ?? []).map((id) => ({
        id,
        type: 'IMAGE',
        fileCreatedAt: '2027-03-20T18:00:00Z',
        exifInfo: null,
        duration: null,
      }));
      return new Response(JSON.stringify({ id: albumId, assets }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (methode === 'POST' && chemin === '/assets') {
      compteurImmich += 1;
      return new Response(JSON.stringify({ id: `immich-asset-${compteurImmich}` }), { status: 201, headers: { 'content-type': 'application/json' } });
    }
    if (methode === 'PUT' && chemin.startsWith('/albums/') && chemin.endsWith('/assets')) {
      const albumId = chemin.slice('/albums/'.length, -'/assets'.length);
      const corps = typeof init?.body === 'string' ? (JSON.parse(init.body) as { ids?: string[] }) : {};
      const existants = assetsParAlbum.get(albumId) ?? [];
      assetsParAlbum.set(albumId, [...existants, ...(corps.ids ?? [])]);
      return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (methode === 'DELETE' && chemin.endsWith('/assets')) {
      return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (methode === 'GET' && chemin.startsWith('/assets/')) {
      return new Response(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]), { status: 200, headers: { 'content-type': 'image/jpeg' } });
    }
    return new Response(JSON.stringify({ error: 'non_trouve' }), { status: 404, headers: { 'content-type': 'application/json' } });
  };
  const dnsLookupImmich = async () => [{ address: '93.184.216.34', family: 4 }] as const;

  const d = decor({ fetchImmich, dnsLookupImmich, agendaExterne: agendaEnMemoire() });
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
  // Une liste de courses (rattachée à l'événement) avec DEUX articles, et une tâche, dans chaque monde (lot 6). Le second article sert de
  // voisin au réordonnancement (`after_item_id` doit être un autre article de la même liste).
  const courses = async (auteur: Personne, g: GroupeAmorce, evenementId: string, titre: string, article: string, voisin: string, tache: string): Promise<Pick<Record<Ressource, string>, 'liste' | 'article' | 'articleVoisin' | 'tache'>> => {
    const liste = await auteur.client.post(`/api/groupes/${g.groupId}/listes`, { title: titre, event_id: evenementId });
    if (liste.statut !== 201) throw new Error(`Liste refusée : ${JSON.stringify(liste.corps)}`);
    const listeId = liste.corps['id'] as string;
    const ajout = async (label: string): Promise<string> => {
      const r = await auteur.client.post(`/api/groupes/${g.groupId}/listes/${listeId}/articles`, { label });
      if (r.statut !== 201) throw new Error(`Article refusé : ${JSON.stringify(r.corps)}`);
      return r.corps['id'] as string;
    };
    const articleId = await ajout(article);
    const voisinId = await ajout(voisin);
    const t = await auteur.client.post(`/api/groupes/${g.groupId}/taches`, { title: tache, event_id: evenementId });
    if (t.statut !== 201) throw new Error(`Tâche refusée : ${JSON.stringify(t.corps)}`);
    return { liste: listeId, article: articleId, articleVoisin: voisinId, tache: t.corps['id'] as string };
  };
  const coursesA = await courses(alice, a, evenementA, 'Courses du groupe A', 'Baguettes de A', 'Fromage de A', 'Apporter la glace de A');
  const coursesB = await courses(bob, b, evenementB, 'Courses de B secret', 'Pain de B', 'Vin de B', 'Tâche secrète de B');
  const sondage = async (
    auteur: Personne,
    g: GroupeAmorce,
    title: string,
  ): Promise<Pick<Record<Ressource, string>, 'sondage' | 'optionSondage'> & { optionSecondaire: string }> => {
    const r = await auteur.client.post(`/api/groupes/${g.groupId}/sondages`, {
      title,
      options: [{ starts_at: '2027-04-11T19:00:00Z' }, { starts_at: '2027-04-12T19:00:00Z' }],
    });
    if (r.statut !== 201) throw new Error(`Sondage refusé : ${JSON.stringify(r.corps)}`);
    const options = r.corps['options'] as Array<{ id: string }>;
    const premiere = options[0]?.id;
    const seconde = options[1]?.id;
    if (premiere === undefined || seconde === undefined) throw new Error('Options de sondage introuvables.');
    return { sondage: r.corps['id'] as string, optionSondage: premiere, optionSecondaire: seconde };
  };
  const sondageA = await sondage(alice, a, 'Sondage du groupe A');
  const sondageB = await sondage(bob, b, 'Sondage secret de B');
  const creneauPerso = async (auteur: Personne, title: string): Promise<string> => {
    const r = await auteur.client.post('/api/moi/agenda', {
      title,
      starts_at: '2027-03-15T14:00:00Z',
      ends_at: '2027-03-15T15:00:00Z',
      time_zone: 'Europe/Paris',
    });
    if (r.statut !== 201) throw new Error(`Créneau personnel refusé : ${JSON.stringify(r.corps)}`);
    return r.corps['id'] as string;
  };
  // Source d'agenda externe (ADR-0013) : un exemplaire par monde, synchronisé depuis un ICS en mémoire (aucun réseau).
  const sourceAgenda = async (auteur: Personne, hote: string): Promise<string> => {
    const r = await auteur.client.post('/api/moi/agenda/sources', { url: `https://${hote}/secret.ics`, label: `Agenda de ${hote}` });
    if (r.statut !== 201) throw new Error(`Source d'agenda refusée : ${JSON.stringify(r.corps)}`);
    return r.corps['id'] as string;
  };
  const sourceAgendaA = await sourceAgenda(alice, 'agenda-alice.exemple.org');
  const sourceAgendaB = await sourceAgenda(bob, 'agenda-bob-confidentiel.exemple.org');
  const creneauPersoA = await creneauPerso(alice, 'Rendez-vous privé Alice');
  const creneauPersoB = await creneauPerso(bob, 'Consultation secrète de Bob');
  const depenseEtRemboursement = async (
    auteur: Personne,
    g: GroupeAmorce,
    evenementId: string,
    label: string,
    payeur: Personne,
    debiteur: Personne,
  ): Promise<{ depense: string; remboursement: string }> => {
    const dRes = await auteur.client.post(`/api/groupes/${g.groupId}/depenses`, {
      event_id: evenementId,
      label,
      spent_on: '2027-03-20',
      payer_membership_id: membreDe(g, payeur),
      amount_minor: 2000,
      currency_code: 'EUR',
      split_mode: 'equal',
      shares: [{ membership_id: membreDe(g, payeur) }, { membership_id: membreDe(g, debiteur) }],
    });
    if (dRes.statut !== 201) throw new Error(`Dépense refusée : ${JSON.stringify(dRes.corps)}`);
    const rRes = await debiteur.client.post(`/api/groupes/${g.groupId}/remboursements`, {
      event_id: evenementId,
      from_membership_id: membreDe(g, debiteur),
      to_membership_id: membreDe(g, auteur),
      amount_minor: 1000,
      currency_code: 'EUR',
      settled_on: '2027-03-21',
    });
    if (rRes.statut !== 201) throw new Error(`Remboursement refusé : ${JSON.stringify(rRes.corps)}`);
    return { depense: dRes.corps['id'] as string, remboursement: rRes.corps['id'] as string };
  };
  const financeA = await depenseEtRemboursement(alice, a, evenementA, 'Dépense secrète A', alice, carole);
  const financeB = await depenseEtRemboursement(bob, b, evenementB, 'Dépense secrète de B', bob, dave);
  const filEtMessage = async (
    auteur: Personne,
    g: GroupeAmorce,
    titre: string,
    texte: string,
  ): Promise<{ fil: string; message: string }> => {
    const fRes = await auteur.client.post(`/api/groupes/${g.groupId}/fils`, { title: titre });
    if (fRes.statut !== 201) throw new Error(`Fil refusé : ${JSON.stringify(fRes.corps)}`);
    const filId = fRes.corps['id'] as string;
    const mRes = await auteur.client.post(`/api/groupes/${g.groupId}/fils/${filId}/messages`, { body: texte });
    if (mRes.statut !== 201) throw new Error(`Message refusé : ${JSON.stringify(mRes.corps)}`);
    return { fil: filId, message: mRes.corps['id'] as string };
  };
  const filA = await filEtMessage(alice, a, 'Fil libre de A', 'Message initial de A');
  const filB = await filEtMessage(bob, b, 'Fil libre secret de B', 'Message secret de B');
  const albumEtPhoto = async (
    admin: Personne,
    deposant: Personne,
    g: GroupeAmorce,
    titre: string,
    apiKey: string,
  ): Promise<{ album: string; photo: string }> => {
    const cfg = await admin.client.put(`/api/groupes/${g.groupId}/immich`, {
      base_url: 'https://immich.exemple.test/api',
      api_key: apiKey,
    });
    if (cfg.statut !== 200) throw new Error(`Config Immich refusée : ${JSON.stringify(cfg.corps)}`);
    const alb = await admin.client.post(`/api/groupes/${g.groupId}/albums`, { title: titre });
    if (alb.statut !== 201) throw new Error(`Album refusé : ${JSON.stringify(alb.corps)}`);
    const albumId = alb.corps['id'] as string;
    const up = await deposant.client.post(`/api/groupes/${g.groupId}/albums/${albumId}/photos`, {
      files: [{ filename: 'photo.jpg', mime_type: 'image/jpeg', content_base64: 'AQID' }],
    });
    if (up.statut !== 201) throw new Error(`Photo refusée : ${JSON.stringify(up.corps)}`);
    const photos = up.corps['photos'] as Array<{ immich_asset_id: string }>;
    const premiere = photos[0];
    if (premiere === undefined) throw new Error('Photo manquante après téléversement.');
    return { album: albumId, photo: premiere.immich_asset_id };
  };
  const photosA = await albumEtPhoto(alice, erin, a, 'Album de A', 'cle-immich-a');
  const photosB = await albumEtPhoto(bob, bob, b, 'Album secret de B', 'cle-immich-b');
  const recueA = await recue(alice);
  const recueB = await recue(bob);
  const avatarAlice = await alice.client.put('/api/moi/avatar', {
    mime: 'image/png',
    data_base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  });
  if (avatarAlice.statut !== 200) throw new Error(`Avatar Alice refusé : ${JSON.stringify(avatarAlice.corps)}`);
  // Bob aussi a une photo : sans elle, l'attaque d'Alice répondrait 404 par simple absence de photo.
  const avatarBob = await bob.client.put('/api/moi/avatar', {
    mime: 'image/png',
    data_base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  });
  if (avatarBob.statut !== 200) throw new Error(`Avatar Bob refusé : ${JSON.stringify(avatarBob.corps)}`);
  // Flux iCal : un abonnement d'Alice et un de Bob (route de révocation), puis les jetons des simples membres.
  const abonnementAlice = await creerFlux(alice, {});
  const abonnementBob = await creerFlux(bob, {});
  const flux: JetonsFlux = {
    erin: await creerFlux(erin, {}),
    erinRestreintA: await creerFlux(erin, { group_id: a.groupId }),
    dave: await creerFlux(dave, {}),
    manonTous: await creerFlux(manon, {}),
    manonRestreintA: await creerFlux(manon, { group_id: a.groupId }),
    manonRestreintB: await creerFlux(manon, { group_id: b.groupId }),
  };
  const ressources = {
    a: { membre: membreDe(a, carole), membreAutre: membreDe(a, erin), evenement: evenementA, invitation: invitationA, session: await idSession(alice), abonnement: abonnementAlice.id, jetonFlux: flux.erin.jeton, sondage: sondageA.sondage, optionSondage: sondageA.optionSondage, creneauPerso: creneauPersoA, sourceAgenda: sourceAgendaA, ...coursesA, ...financeA, ...filA, ...photosA, ...recueA, utilisateur: alice.userId },
    b: { membre: membreDe(b, dave), membreAutre: membreDe(b, manon), evenement: evenementB, invitation: invitationB, session: await idSession(bob), abonnement: abonnementBob.id, jetonFlux: flux.dave.jeton, sondage: sondageB.sondage, optionSondage: sondageB.optionSondage, creneauPerso: creneauPersoB, sourceAgenda: sourceAgendaB, ...coursesB, ...financeB, ...filB, ...photosB, ...recueB, utilisateur: bob.userId },
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
    'Courses de B secret',
    'Pain de B',
    'Vin de B',
    'Tâche secrète de B',
    'Sondage secret de B',
    'Consultation secrète de Bob',
    'Dépense secrète de B',
    'Fil libre secret de B',
    'Message secret de B',
    'Album secret de B',
    sondageB.optionSecondaire,
    ...Object.values(ressources.b),
  ];
  return { d, alice, bob, carole, dave, erin, manon, frank, a, b, ressources, marquesDeB, flux };
}
