import { useState, type FormEvent } from 'react';
import {
  changerRole,
  inviter,
  listerInvitationsEmises,
  listerMembres,
  modifierGroupe,
  quitterGroupe,
  retirerMembre,
  revoquerInvitation,
  supprimerGroupe,
  type InvitationEmise,
  type Membre,
} from '../api/groupes';
import {
  configurerImmich,
  lireConfigImmich,
  supprimerConfigImmich,
  testerConfigImmich,
  type EtatImmich,
} from '../api/immich';
import { ChargementPage, SqueletteCarte } from '../components/ChargementPage';
import { ChampFuseau } from '../components/ChampFuseau';
import { DialogueConfirmation } from '../components/DialogueConfirmation';
import { EnteteGroupe } from '../components/EnteteGroupe';
import { Erreur, messageDe } from '../components/Erreur';
import { useGroupe } from '../components/FournisseurGroupe';
import {
  IconeCalendrier,
  IconeCamera,
  IconeEnveloppe,
  IconeGroupes,
  IconeListe,
  IconeMessage,
  IconeParametres,
  IconeRecu,
  IconeSondage,
} from '../components/Icones';
import { fusionnerEtats, premiereErreur } from '../hooks/etatsLecture';
import { useLecture } from '../hooks/useLecture';
import { useSoumission } from '../hooks/useSoumission';
import { t, type CleTexte } from '../i18n';

/** La cible affichée d'une invitation émise (courriel ou nom d'utilisateur), vide si le serveur n'en donne aucune. */
function cibleInvitation(i: InvitationEmise): string {
  return i.email ?? i.username ?? '';
}

function initialesMembre(nom: string): string {
  const morceaux = nom.trim().split(/\s+/).filter(Boolean);
  if (morceaux.length === 0) return '?';
  if (morceaux.length === 1) return (morceaux[0] ?? '?').slice(0, 2).toUpperCase();
  return `${morceaux[0]?.[0] ?? ''}${morceaux[morceaux.length - 1]?.[0] ?? ''}`.toUpperCase();
}

/** Tout ce que la page affiche. `immich` est `null` hors admin, ou quand sa lecture a échoué (`erreurImmich`). */
interface DonneesGroupe {
  readonly membres: Membre[];
  readonly invitations: InvitationEmise[];
  readonly immich: EtatImmich | null;
  readonly erreurImmich: string | null;
}

/** Lit les membres, puis (admin seulement) invitations et configuration Immich en parallèle. Le groupe vient du contexte. */
async function lireTout(groupId: string, estAdmin: boolean): Promise<DonneesGroupe> {
  if (!estAdmin) {
    return { membres: await listerMembres(groupId), invitations: [], immich: null, erreurImmich: null };
  }
  const [membres, invitations, immich] = await Promise.allSettled([
    listerMembres(groupId),
    listerInvitationsEmises(groupId),
    lireConfigImmich(groupId),
  ]);
  // Membres et invitations sont indispensables à la page ; Immich échoue dans sa seule carte.
  if (membres.status === 'rejected') throw membres.reason;
  if (invitations.status === 'rejected') throw invitations.reason;
  return {
    membres: membres.value,
    invitations: invitations.value,
    immich: immich.status === 'fulfilled' ? immich.value : null,
    erreurImmich: immich.status === 'rejected' ? messageDe(immich.reason) : null,
  };
}

/** Un groupe : en-tête, raccourcis Bento, membres, invitations (admin), Immich (admin) et paramètres. */
export function Groupe({
  groupId,
  serviceEmail,
  onQuitte,
}: {
  groupId: string;
  serviceEmail?: 'actif' | 'non_configure';
  onQuitte: () => void;
}) {
  const { groupe, etat: etatGroupe, erreur: erreurGroupe, rechargerGroupe, rafraichirGroupe } = useGroupe();
  // `null` = rôle encore inconnu. Les lectures d'admin ne partent qu'une fois le rôle connu ; la
  // fusion des états garde UN seul squelette pendant cette seconde phase.
  const role = groupe?.mon_role ?? null;
  const {
    donnees,
    etat: etatPage,
    erreur: erreurPage,
    recharger,
  } = useLecture(() => (role === null ? Promise.resolve(null) : lireTout(groupId, role === 'admin')), [groupId, role]);
  const etat = fusionnerEtats(etatGroupe, etatPage);
  const erreurLecture = premiereErreur(erreurGroupe, erreurPage);
  // Relecture silencieuse après une action : la page reste affichée, sans repasser par le squelette.
  const [fraiches, setFraiches] = useState<DonneesGroupe | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [mode, setMode] = useState<'email' | 'username'>('email');
  const [cible, setCible] = useState('');
  const [immichUrl, setImmichUrl] = useState('');
  const [immichCle, setImmichCle] = useState('');
  const [editionImmich, setEditionImmich] = useState(false);
  const [aPromouvoir, setAPromouvoir] = useState<Membre | null>(null);
  const [aRetirer, setARetirer] = useState<Membre | null>(null);
  const [aRevoquer, setARevoquer] = useState<InvitationEmise | null>(null);
  const [quitterOuvert, setQuitterOuvert] = useState(false);
  const [supprimerOuvert, setSupprimerOuvert] = useState(false);
  const [editionParametres, setEditionParametres] = useState(false);
  const [nomEdite, setNomEdite] = useState('');
  const [deviseEditee, setDeviseEditee] = useState('');
  const [fuseauEdite, setFuseauEdite] = useState('');
  const [debrancherOuvert, setDebrancherOuvert] = useState(false);
  // Une garde par action indépendante : inviter ne grise pas « Quitter », etc.
  const invitation = useSoumission();
  const membre = useSoumission();
  const revocation = useSoumission();
  const immichAction = useSoumission();
  const parametresAction = useSoumission();
  const sortie = useSoumission();

  const rafraichir = async (): Promise<void> => {
    // Le groupe aussi : un branchement Immich change `fonctionnalites.photos`, donc l'onglet Photos de l'en-tête.
    rafraichirGroupe();
    setFraiches(await lireTout(groupId, role === 'admin'));
  };
  const relire = (): void => {
    setFraiches(null);
    rechargerGroupe();
    recharger();
  };

  const agir = (
    garde: ReturnType<typeof useSoumission>,
    action: () => Promise<void>,
    apres: () => void = () => undefined,
  ): void => {
    setErreur(null);
    setInfo(null);
    garde
      .lancer(async () => {
        await action();
        apres();
      })
      .catch((err: unknown) => setErreur(messageDe(err)));
  };

  const soumettreInvitation = (e: FormEvent): void => {
    e.preventDefault();
    agir(
      invitation,
      async () => {
        await inviter(groupId, mode === 'email' ? { email: cible } : { username: cible }, 'member');
        await rafraichir();
      },
      () => {
        setCible('');
        setInfo(t('invitations_emises.envoyee'));
      },
    );
  };

  const courantes = fraiches ?? donnees;
  if (courantes === null || groupe === null) {
    // Groupe lu mais page pas encore relancée (rôle tout juste connu) : état transitoire, toujours le squelette.
    const etatAffiche = etat === 'pret' ? 'chargement' : etat;
    return (
      <section className="page-groupe-pile">
        <ChargementPage etat={etatAffiche} erreur={erreurLecture} onReessayer={relire} squelette={<SqueletteCarte />}>
          {null}
        </ChargementPage>
        {etatAffiche === 'erreur' && <a href="#/">{t('lien.retour')}</a>}
      </section>
    );
  }
  const { membres, invitations, immich, erreurImmich } = courantes;
  const changerLeRole = (m: Membre): void =>
    agir(membre, async () => {
      await changerRole(groupId, m.id, m.role === 'admin' ? 'member' : 'admin');
      await rafraichir();
    });
  const admin = groupe.mon_role === 'admin';
  const base = `#/groupe/${encodeURIComponent(groupId)}`;
  const nbActifs = membres.filter((m) => m.status === 'active').length;
  const libelleMembres = t(nbActifs <= 1 ? 'groupe.nb_membres_singulier' : 'groupe.nb_membres_pluriel', {
    n: String(nbActifs),
  });

  const modules = [
    {
      href: `${base}/agenda`,
      titre: t('groupe_nav.agenda'),
      desc: t('groupe.raccourci_agenda_desc'),
      icone: <IconeCalendrier className="kpi-icone" />,
      badge: 'kpi-badge-indigo',
      visible: true,
    },
    {
      href: `${base}/listes`,
      titre: t('groupe_nav.listes'),
      desc: t('groupe.raccourci_listes_desc'),
      icone: <IconeListe className="kpi-icone" />,
      badge: 'kpi-badge-emeraude',
      visible: true,
    },
    {
      href: `${base}/sondages`,
      titre: t('groupe_nav.sondages'),
      desc: t('groupe.raccourci_sondages_desc'),
      icone: <IconeSondage className="kpi-icone" />,
      badge: 'kpi-badge-ambre',
      visible: true,
    },
    {
      href: `${base}/depenses`,
      titre: t('groupe_nav.depenses'),
      desc: t('groupe.raccourci_depenses_desc'),
      icone: <IconeRecu className="kpi-icone" />,
      badge: 'kpi-badge-rose',
      visible: true,
    },
    {
      href: `${base}/fils`,
      titre: t('groupe_nav.fils'),
      desc: t('groupe.raccourci_fils_desc'),
      icone: <IconeMessage className="kpi-icone" />,
      badge: 'kpi-badge-indigo',
      visible: true,
    },
    {
      href: `${base}/albums`,
      titre: t('groupe_nav.photos'),
      desc: t('groupe.raccourci_photos_desc'),
      icone: <IconeCamera className="kpi-icone" />,
      badge: 'kpi-badge-ambre',
      visible: groupe.fonctionnalites.photos,
    },
  ];

  return (
    <section className="page-groupe-pile">
      <EnteteGroupe
        ongletActif="apercu"
        meta={
          <>
            <span className={`pilule${admin ? ' pilule-role-admin' : ''}`}>
              {t(admin ? 'groupe.role_admin_court' : 'groupe.role_member_court')}
            </span>
            <span className="pilule">{libelleMembres}</span>
            <span className="pilule">{groupe.default_currency_code}</span>
          </>
        }
        actions={
          <div className="actions-rapides">
            <a href={`${base}/evenement-nouveau`} className="bouton bouton-primaire action-rapide">
              {t('groupe.action_evenement')}
            </a>
            <a href={`${base}/depenses`} className="bouton action-rapide">
              {t('groupe.action_depense')}
            </a>
            <a href={`${base}/listes`} className="bouton action-rapide">
              {t('groupe.action_liste')}
            </a>
            <a href={`${base}/sondages`} className="bouton action-rapide">
              {t('groupe.action_sondage')}
            </a>
          </div>
        }
      />

      <Erreur message={premiereErreur(erreur, erreurGroupe)} />

      <div className="grille-bento-groupe">
        <div className="bento-colonne-gauche">
          <div className="carte">
            <div className="carte-entete">
              <h3 className="widget-titre">
                <IconeGroupes className="widget-titre-icone icone-indigo" />
                <span>{t('groupe.modules_titre')}</span>
              </h3>
            </div>
            <div className="grille-modules">
              {modules
                .filter((m) => m.visible)
                .map((m) => (
                  <a key={m.href} href={m.href} className="tuile-module">
                    <span className={`kpi-icone-badge module-icone-badge ${m.badge}`}>{m.icone}</span>
                    <span className="tuile-module-texte">
                      <strong className="tuile-module-titre">{m.titre}</strong>
                      <span className="tuile-module-desc">{m.desc}</span>
                    </span>
                  </a>
                ))}
            </div>
          </div>

          <div className="carte">
            <div className="carte-entete">
              <h3 className="widget-titre">
                <IconeGroupes className="widget-titre-icone icone-emeraude" />
                <span>{t('membres.titre')}</span>
              </h3>
              <span className="pilule">{libelleMembres}</span>
            </div>
            <ul className="liste-elements">
              {membres.map((m) => {
                const actif = m.status === 'active';
                return (
                  <li key={m.id} className="ligne ligne-membre">
                    <div className="ligne-membre-info">
                      {m.avatar_url !== null ? (
                        <img
                          src={m.avatar_url}
                          alt={t('avatar.alt', { nom: m.display_name })}
                          className="avatar-photo avatar-photo-mini"
                        />
                      ) : (
                        <span className="avatar-initiales avatar-initiales-mini" aria-hidden="true">
                          {initialesMembre(m.display_name)}
                        </span>
                      )}
                      <div className="ligne-principale">
                        <span className="ligne-titre">{m.display_name}</span>
                        <div className="ligne-badges">
                          <span className={`pilule${m.role === 'admin' ? ' pilule-role-admin' : ''}`}>
                            {t(m.role === 'admin' ? 'groupe.role_admin_court' : 'groupe.role_member_court')}
                          </span>
                          {!actif && <span className="pilule">{t('groupe.ancien_membre')}</span>}
                        </div>
                      </div>
                    </div>
                    {admin && actif && m.id !== groupe.mon_appartenance_id && (
                      <div className="ligne-actions-discretes">
                        <button
                          type="button"
                          className="bouton-compact"
                          aria-label={`${t(m.role === 'admin' ? 'membres.retrograder' : 'membres.promouvoir')} ${m.display_name}`}
                          disabled={membre.enCours}
                          onClick={() => (m.role === 'admin' ? changerLeRole(m) : setAPromouvoir(m))}
                        >
                          {t(m.role === 'admin' ? 'membres.retrograder' : 'membres.promouvoir')}
                        </button>
                        <button
                          type="button"
                          className="bouton-compact bouton-danger-discret"
                          aria-label={`${t('membres.retirer')} ${m.display_name}`}
                          disabled={membre.enCours}
                          onClick={() => setARetirer(m)}
                        >
                          {t('membres.retirer')}
                        </button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        </div>

        <div className="bento-colonne-droite">
          {admin && (
            <div className="carte">
              <div className="carte-entete">
                <h3 className="widget-titre">
                  <IconeEnveloppe className="widget-titre-icone icone-indigo" />
                  <span>{t('invitations_emises.titre')}</span>
                </h3>
              </div>
              <form onSubmit={soumettreInvitation} className="formulaire-compact">
                <div className="barre-onglets" role="group" aria-label={t('invitations_emises.titre')}>
                  <button type="button" aria-pressed={mode === 'email'} onClick={() => setMode('email')}>
                    {t('invitations_emises.par_email')}
                  </button>
                  <button type="button" aria-pressed={mode === 'username'} onClick={() => setMode('username')}>
                    {t('invitations_emises.par_nom_court')}
                  </button>
                </div>
                <div className="ligne-ajout-compact">
                  <input
                    type={mode === 'email' ? 'email' : 'text'}
                    value={cible}
                    onChange={(e) => setCible(e.target.value)}
                    aria-label={t(mode === 'email' ? 'invitations_emises.cible_email' : 'invitations_emises.cible_nom')}
                    placeholder={t(
                      mode === 'email' ? 'invitations_emises.cible_email' : 'invitations_emises.cible_nom',
                    )}
                    required
                  />
                  <button type="submit" disabled={invitation.enCours}>
                    {invitation.enCours ? t('commun.envoi') : t('invitations_emises.inviter')}
                  </button>
                </div>
              </form>
              {serviceEmail === 'non_configure' && (
                <p className="texte-doux">{t('invitations_emises.sans_email')}</p>
              )}
              {info !== null && (
                <p role="status" className="info">
                  {info}
                </p>
              )}
              {invitations.length === 0 ? (
                <p className="discret">{t('invitations_emises.aucune')}</p>
              ) : (
                <ul className="liste-elements liste-compacte-haut">
                  {invitations.map((i) => (
                    <li key={i.id} className="ligne">
                      <div className="ligne-principale">
                        <span className="ligne-titre">{cibleInvitation(i)}</span>
                        <span className="ligne-meta">{t(`invitations_emises.statut_${i.status}` as CleTexte)}</span>
                      </div>
                      {i.status === 'pending' && (
                        <button
                          type="button"
                          className="bouton-compact"
                          aria-label={
                            cibleInvitation(i) === ''
                              ? undefined
                              : `${t('invitations_emises.revoquer')} ${cibleInvitation(i)}`
                          }
                          disabled={revocation.enCours}
                          onClick={() => setARevoquer(i)}
                        >
                          {t('invitations_emises.revoquer')}
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {admin && (
            <div className="carte">
              <div className="carte-entete">
                <h3 className="widget-titre">
                  <IconeCamera className="widget-titre-icone icone-ambre" />
                  <span>{t('immich.titre')}</span>
                </h3>
                {immich !== null && immich.configure && (
                  <span className={`pilule${immich.status === 'ok' ? ' pilule-statut-yes' : ' pilule-statut-maybe'}`}>
                    {t(`immich.statut_${immich.status}` as CleTexte)}
                  </span>
                )}
              </div>
              {immich !== null && immich.configure ? (
                <div className="bloc-immich-resume">
                  <p className="discret ligne-meta">
                    {t('immich.etat', {
                      url: immich.base_url,
                      statut: t(`immich.statut_${immich.status}` as CleTexte),
                    })}
                  </p>
                  <div className="barre">
                    <button
                      type="button"
                      className="bouton-compact"
                      disabled={immichAction.enCours}
                      onClick={() =>
                        agir(immichAction, async () => {
                          await testerConfigImmich(groupId);
                          await rafraichir();
                        })
                      }
                    >
                      {t('immich.tester')}
                    </button>
                    <button
                      type="button"
                      className="bouton-compact"
                      onClick={() => {
                        if (!editionImmich && immichUrl === '') setImmichUrl(immich.base_url);
                        setEditionImmich(!editionImmich);
                      }}
                    >
                      {t(editionImmich ? 'groupe.immich_masquer' : 'groupe.immich_modifier')}
                    </button>
                    <button
                      type="button"
                      className="bouton-compact bouton-danger-discret"
                      disabled={immichAction.enCours}
                      onClick={() => setDebrancherOuvert(true)}
                    >
                      {t('immich.debrancher')}
                    </button>
                  </div>
                </div>
              ) : erreurImmich !== null ? (
                <Erreur
                  message={erreurImmich}
                  onReessayer={() => void rafraichir().catch((err: unknown) => setErreur(messageDe(err)))}
                />
              ) : (
                <div className="bloc-immich-resume">
                  <p className="discret">{t('immich.non_configure')}</p>
                  {!editionImmich && (
                    <button type="button" className="bouton-compact" onClick={() => setEditionImmich(true)}>
                      {t('groupe.immich_configurer')}
                    </button>
                  )}
                </div>
              )}
              {editionImmich && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    agir(
                      immichAction,
                      async () => {
                        await configurerImmich(groupId, immichUrl, immichCle);
                        await rafraichir();
                      },
                      () => {
                        setImmichCle('');
                        setEditionImmich(false);
                      },
                    );
                  }}
                  className="formulaire liste-compacte-haut"
                >
                  <label>
                    {t('immich.url')}
                    <input type="url" value={immichUrl} onChange={(e) => setImmichUrl(e.target.value)} required />
                  </label>
                  <label>
                    {t('immich.cle')}
                    <input type="password" value={immichCle} onChange={(e) => setImmichCle(e.target.value)} required />
                  </label>
                  <button type="submit" disabled={immichAction.enCours}>
                    {immichAction.enCours ? t('commun.enregistrement') : t('immich.enregistrer')}
                  </button>
                </form>
              )}
            </div>
          )}

          <div className="carte carte-parametres-discrets">
            <div className="carte-entete">
              <h3 className="widget-titre">
                <IconeParametres className="widget-titre-icone" />
                <span>{t('groupe.parametres_titre')}</span>
              </h3>
              {role === 'admin' && !editionParametres && (
                <button
                  type="button"
                  className="bouton-compact"
                  onClick={() => {
                    setNomEdite(groupe.name);
                    setDeviseEditee(groupe.default_currency_code);
                    setFuseauEdite(groupe.time_zone);
                    setEditionParametres(true);
                  }}
                >
                  {t('groupe.modifier_parametres')}
                </button>
              )}
            </div>
            {editionParametres && role === 'admin' ? (
              <form
                className="formulaire"
                onSubmit={(e) => {
                  e.preventDefault();
                  agir(
                    parametresAction,
                    async () => {
                      await modifierGroupe(groupId, {
                        name: nomEdite.trim(),
                        default_currency_code: deviseEditee.trim().toUpperCase(),
                        time_zone: fuseauEdite.trim(),
                      });
                      await rafraichir();
                    },
                    () => {
                      setEditionParametres(false);
                      setInfo(t('groupe.parametres_enregistres'));
                    },
                  );
                }}
              >
                <label>
                  {t('groupe.champ_nom')}
                  <input type="text" value={nomEdite} maxLength={80} onChange={(e) => setNomEdite(e.target.value)} required />
                </label>
                <div className="grille-champs-2">
                  <label>
                    {t('groupe.champ_devise')}
                    <input
                      type="text"
                      value={deviseEditee}
                      maxLength={3}
                      onChange={(e) => setDeviseEditee(e.target.value)}
                      required
                    />
                  </label>
                  <label>
                    {t('groupe.champ_fuseau')}
                    <ChampFuseau value={fuseauEdite} onChange={setFuseauEdite} />
                  </label>
                </div>
                <div className="barre-compacte">
                  <button type="submit" disabled={parametresAction.enCours}>
                    {parametresAction.enCours ? t('commun.enregistrement') : t('commun.enregistrer')}
                  </button>
                  <button type="button" onClick={() => setEditionParametres(false)}>
                    {t('commun.annuler')}
                  </button>
                </div>
              </form>
            ) : (
              <div className="groupe-meta">
                <span className="pilule">{t('groupe.devise', { devise: groupe.default_currency_code })}</span>
                <span className="pilule">{t('groupe.fuseau', { fuseau: groupe.time_zone })}</span>
              </div>
            )}
            <div className="liste-compacte-haut barre-compacte">
              <button
                type="button"
                className="bouton-danger-discret"
                disabled={sortie.enCours}
                onClick={() => setQuitterOuvert(true)}
              >
                {t('groupe.quitter')}
              </button>
              {role === 'admin' && (
                <button
                  type="button"
                  className="bouton-danger-discret"
                  disabled={sortie.enCours}
                  onClick={() => setSupprimerOuvert(true)}
                >
                  {t('groupe.supprimer')}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      <DialogueConfirmation
        ouvert={aPromouvoir !== null}
        titre={t('confirm.membres.promouvoir.titre', { nom: aPromouvoir?.display_name ?? '' })}
        consequence={t('confirm.membres.promouvoir.consequence')}
        reversible={true}
        libelleConfirmer={t('confirm.membres.promouvoir.action')}
        danger={false}
        onConfirmer={() => {
          if (aPromouvoir !== null) changerLeRole(aPromouvoir);
          setAPromouvoir(null);
        }}
        onAnnuler={() => setAPromouvoir(null)}
      />
      <DialogueConfirmation
        ouvert={aRetirer !== null}
        titre={t('confirm.membres.retirer.titre', { nom: aRetirer?.display_name ?? '' })}
        consequence={t('confirm.membres.retirer.consequence')}
        reversible={true}
        libelleConfirmer={t('confirm.membres.retirer.action')}
        danger
        onConfirmer={() => {
          if (aRetirer !== null) {
            const m = aRetirer;
            agir(membre, async () => {
              await retirerMembre(groupId, m.id);
              await rafraichir();
            });
          }
          setARetirer(null);
        }}
        onAnnuler={() => setARetirer(null)}
      />
      <DialogueConfirmation
        ouvert={aRevoquer !== null}
        titre={t('confirm.invitations_emises.revoquer.titre', {
          cible: aRevoquer === null ? '' : cibleInvitation(aRevoquer),
        })}
        consequence={t('confirm.invitations_emises.revoquer.consequence')}
        reversible={true}
        libelleConfirmer={t('confirm.invitations_emises.revoquer.action')}
        danger
        onConfirmer={() => {
          if (aRevoquer !== null) {
            const i = aRevoquer;
            agir(revocation, async () => {
              await revoquerInvitation(groupId, i.id);
              await rafraichir();
            });
          }
          setARevoquer(null);
        }}
        onAnnuler={() => setARevoquer(null)}
      />
      <DialogueConfirmation
        ouvert={quitterOuvert}
        titre={t('confirm.groupe.quitter.titre', { groupe: groupe.name })}
        consequence={t('confirm.groupe.quitter.consequence')}
        reversible={false}
        libelleConfirmer={t('confirm.groupe.quitter.action')}
        danger
        onConfirmer={() => {
          setQuitterOuvert(false);
          agir(sortie, () => quitterGroupe(groupId), onQuitte);
        }}
        onAnnuler={() => setQuitterOuvert(false)}
      />
      <DialogueConfirmation
        ouvert={supprimerOuvert}
        titre={t('confirm.groupe.supprimer.titre', { groupe: groupe.name })}
        consequence={t('confirm.groupe.supprimer.consequence')}
        reversible={false}
        libelleConfirmer={t('confirm.groupe.supprimer.action')}
        danger
        onConfirmer={() => {
          setSupprimerOuvert(false);
          agir(sortie, () => supprimerGroupe(groupId), onQuitte);
        }}
        onAnnuler={() => setSupprimerOuvert(false)}
      />
      <DialogueConfirmation
        ouvert={debrancherOuvert}
        titre={t('confirm.immich.debrancher.titre')}
        consequence={t('confirm.immich.debrancher.consequence')}
        reversible={true}
        libelleConfirmer={t('confirm.immich.debrancher.action')}
        danger={false}
        onConfirmer={() => {
          setDebrancherOuvert(false);
          agir(
            immichAction,
            async () => {
              await supprimerConfigImmich(groupId);
              await rafraichir();
            },
            () => {
              setImmichUrl('');
              setImmichCle('');
              setEditionImmich(false);
            },
          );
        }}
        onAnnuler={() => setDebrancherOuvert(false)}
      />
    </section>
  );
}
