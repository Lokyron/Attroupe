import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  changerRole,
  inviter,
  lireGroupe,
  listerInvitationsEmises,
  listerMembres,
  quitterGroupe,
  retirerMembre,
  revoquerInvitation,
  type DetailGroupe,
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
import { EnteteGroupe } from '../components/EnteteGroupe';
import { Erreur, messageDe } from '../components/Erreur';
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

/** Un groupe : en-tête, raccourcis Bento, membres, invitations (admin), Immich (admin) et paramètres. */
export function Groupe({ groupId, onQuitte }: { groupId: string; onQuitte: () => void }) {
  const [groupe, setGroupe] = useState<DetailGroupe | null>(null);
  const [membres, setMembres] = useState<Membre[]>([]);
  const [invitations, setInvitations] = useState<InvitationEmise[]>([]);
  const [erreur, setErreur] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [mode, setMode] = useState<'email' | 'username'>('email');
  const [cible, setCible] = useState('');
  const [immich, setImmich] = useState<EtatImmich | null>(null);
  const [immichUrl, setImmichUrl] = useState('');
  const [immichCle, setImmichCle] = useState('');
  const [editionImmich, setEditionImmich] = useState(false);

  const charger = useCallback((): void => {
    setErreur(null);
    lireGroupe(groupId)
      .then(async (g) => {
        setGroupe(g);
        setMembres(await listerMembres(groupId));
        if (g.mon_role === 'admin') {
          setInvitations(await listerInvitationsEmises(groupId));
          const cfg = await lireConfigImmich(groupId);
          setImmich(cfg);
          if (cfg.configure) setImmichUrl(cfg.base_url);
        } else {
          setInvitations([]);
          setImmich(null);
        }
      })
      .catch((err: unknown) => setErreur(messageDe(err)));
  }, [groupId]);
  useEffect(charger, [charger]);

  const agir = (action: Promise<void>, apres: () => void = charger): void => {
    setErreur(null);
    setInfo(null);
    action.then(apres).catch((err: unknown) => setErreur(messageDe(err)));
  };

  const soumettreInvitation = (e: FormEvent): void => {
    e.preventDefault();
    agir(inviter(groupId, mode === 'email' ? { email: cible } : { username: cible }, 'member'), () => {
      setCible('');
      setInfo(t('invitations_emises.envoyee'));
      charger();
    });
  };

  if (groupe === null) return <Erreur message={erreur} />;
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
        groupId={groupId}
        ongletActif="apercu"
        nomGroupe={groupe.name}
        photosActives={groupe.fonctionnalites.photos}
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

      <Erreur message={erreur} />

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
                          onClick={() => agir(changerRole(groupId, m.id, m.role === 'admin' ? 'member' : 'admin'))}
                        >
                          {t(m.role === 'admin' ? 'membres.retrograder' : 'membres.promouvoir')}
                        </button>
                        <button
                          type="button"
                          className="bouton-compact bouton-danger-discret"
                          aria-label={`${t('membres.retirer')} ${m.display_name}`}
                          onClick={() => window.confirm(t('membres.retirer_confirmation')) && agir(retirerMembre(groupId, m.id))}
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
                    placeholder={t(mode === 'email' ? 'invitations_emises.cible_email' : 'invitations_emises.cible_nom')}
                    required
                  />
                  <button type="submit">{t('invitations_emises.inviter')}</button>
                </div>
              </form>
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
                        <span className="ligne-titre">{i.email ?? i.username ?? ''}</span>
                        <span className="ligne-meta">{t(`invitations_emises.statut_${i.status}` as CleTexte)}</span>
                      </div>
                      {i.status === 'pending' && (
                        <button
                          type="button"
                          className="bouton-compact"
                          aria-label={cibleInvitation(i) === '' ? undefined : `${t('invitations_emises.revoquer')} ${cibleInvitation(i)}`}
                          onClick={() => agir(revoquerInvitation(groupId, i.id))}
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
                      onClick={() =>
                        agir(
                          testerConfigImmich(groupId).then((etat) => {
                            setImmich(etat);
                          }),
                        )
                      }
                    >
                      {t('immich.tester')}
                    </button>
                    <button type="button" className="bouton-compact" onClick={() => setEditionImmich(!editionImmich)}>
                      {t(editionImmich ? 'groupe.immich_masquer' : 'groupe.immich_modifier')}
                    </button>
                    <button
                      type="button"
                      className="bouton-compact bouton-danger-discret"
                      onClick={() =>
                        window.confirm(t('immich.debrancher_confirmation')) &&
                        agir(supprimerConfigImmich(groupId), () => {
                          setImmichUrl('');
                          setImmichCle('');
                          setEditionImmich(false);
                          charger();
                        })
                      }
                    >
                      {t('immich.debrancher')}
                    </button>
                  </div>
                </div>
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
                      configurerImmich(groupId, immichUrl, immichCle).then((etat) => {
                        setImmich(etat);
                        setImmichCle('');
                        setEditionImmich(false);
                      }),
                      charger,
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
                  <button type="submit">{t('immich.enregistrer')}</button>
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
            </div>
            <div className="groupe-meta">
              <span className="pilule">{t('groupe.devise', { devise: groupe.default_currency_code })}</span>
              <span className="pilule">{t('groupe.fuseau', { fuseau: groupe.time_zone })}</span>
            </div>
            <div className="liste-compacte-haut">
              <button
                type="button"
                className="bouton-danger-discret"
                onClick={() => window.confirm(t('groupe.quitter_confirmation')) && agir(quitterGroupe(groupId), onQuitte)}
              >
                {t('groupe.quitter')}
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
