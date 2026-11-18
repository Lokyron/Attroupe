import { useCallback, useEffect, useState } from 'react';
import {
  ajouterOrganisateur,
  annulerEvenement,
  lireEvenement,
  lirePresences,
  repondre,
  retirerOrganisateur,
  type DetailEvenement,
  type Presences,
  type ReponsePresence,
} from '../api/evenements';
import { lireGroupe, listerMembres, type Membre } from '../api/groupes';
import { libelleDateHoraire } from '../agenda/format';
import { EnteteGroupe } from '../components/EnteteGroupe';
import { Erreur, messageDe } from '../components/Erreur';
import { FilDiscussion } from '../components/FilDiscussion';
import { FormulaireEvenement } from '../components/FormulaireEvenement';
import { IconeCalendrier, IconeLieu, IconeMessage } from '../components/Icones';
import { TachesEvenement } from '../components/TachesEvenement';
import { SectionDepenses } from './Depenses';
import { t } from '../i18n';

const REPONSES: readonly ReponsePresence[] = ['yes', 'maybe', 'no'];

/** Création d'un événement : le formulaire, puis le détail du nouvel événement. */
export function NouvelEvenement({ groupId }: { groupId: string }) {
  const [fuseau, setFuseau] = useState<string | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  useEffect(() => {
    lireGroupe(groupId)
      .then((g) => setFuseau(g.time_zone))
      .catch((err: unknown) => setErreur(messageDe(err)));
  }, [groupId]);
  const agenda = `#/groupe/${encodeURIComponent(groupId)}/agenda`;
  if (fuseau === null) return <Erreur message={erreur} />;
  return (
    <section className="page-groupe-pile">
      <EnteteGroupe
        groupId={groupId}
        ongletActif="agenda"
        titre={t('evenement_form.titre_creation')}
        lienRetour={{ href: agenda, libelle: t('evenement.retour_agenda') }}
      />
      <div className="carte">
        <FormulaireEvenement
          groupId={groupId}
          fuseauParDefaut={fuseau}
          onEnregistre={(e) => {
            window.location.hash = `#/groupe/${encodeURIComponent(groupId)}/evenement/${encodeURIComponent(e.id)}`;
          }}
          onAnnule={() => {
            window.location.hash = agenda;
          }}
        />
      </div>
    </section>
  );
}

/** Détail d'un événement : 2 colonnes sur desktop (détails, RSVP, tâches, dépenses d'un côté ; discussion de l'autre). */
export function Evenement({ groupId, evenementId }: { groupId: string; evenementId: string }) {
  const [evenement, setEvenement] = useState<DetailEvenement | null>(null);
  const [presences, setPresences] = useState<Presences | null>(null);
  const [membres, setMembres] = useState<Membre[]>([]);
  const [edition, setEdition] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const [choix, setChoix] = useState<ReponsePresence | null>(null);
  const [invites, setInvites] = useState(0);
  const [commentaire, setCommentaire] = useState('');
  const [aAjouter, setAAjouter] = useState('');

  const adopter = useCallback((e: DetailEvenement): void => {
    setEvenement(e);
    setChoix(e.ma_presence?.status ?? null);
    setInvites(e.ma_presence?.guests_count ?? 0);
    setCommentaire(e.ma_presence?.comment ?? '');
  }, []);

  const charger = useCallback((): void => {
    setErreur(null);
    Promise.all([lireEvenement(groupId, evenementId), lirePresences(groupId, evenementId), listerMembres(groupId)])
      .then(([e, p, m]) => {
        adopter(e);
        setPresences(p);
        setMembres(m);
      })
      .catch((err: unknown) => setErreur(messageDe(err)));
  }, [groupId, evenementId, adopter]);
  useEffect(charger, [charger]);

  const agir = (action: Promise<DetailEvenement>): void => {
    setErreur(null);
    action
      .then((e) => {
        adopter(e);
        return lirePresences(groupId, evenementId);
      })
      .then(setPresences)
      .catch((err: unknown) => setErreur(messageDe(err)));
  };

  if (evenement === null) return <Erreur message={erreur} />;
  const annule = evenement.status === 'cancelled';
  const agenda = `#/groupe/${encodeURIComponent(groupId)}/agenda`;
  const dejaOrganisateurs = new Set(evenement.organisateurs.map((o) => o.membership_id));
  const candidats = membres.filter((m) => m.status === 'active' && !dejaOrganisateurs.has(m.id));

  if (edition) {
    return (
      <section className="page-groupe-pile">
        <EnteteGroupe
          groupId={groupId}
          ongletActif="agenda"
          titre={t('evenement_form.titre_modification')}
          lienRetour={{ href: agenda, libelle: t('evenement.retour_agenda') }}
        />
        <div className="carte">
          <FormulaireEvenement
            groupId={groupId}
            fuseauParDefaut={evenement.time_zone}
            initial={evenement}
            onEnregistre={(e) => {
              adopter(e);
              setEdition(false);
            }}
            onAnnule={() => setEdition(false)}
          />
        </div>
      </section>
    );
  }

  return (
    <section className="page-groupe-pile">
      <EnteteGroupe
        groupId={groupId}
        ongletActif="agenda"
        titre={evenement.title}
        lienRetour={{ href: agenda, libelle: t('evenement.retour_agenda') }}
        meta={
          <>
            <span className="pilule">
              <IconeCalendrier className="icone-mini" />
              <span>{libelleDateHoraire(evenement)}</span>
            </span>
            {annule && (
              <span role="status" className="pilule pilule-statut-no">
                {t('agenda.annule')}
              </span>
            )}
          </>
        }
        actions={
          evenement.peut_modifier ? (
            <div className="barre-compacte">
              <button type="button" className="bouton-compact" onClick={() => setEdition(true)}>
                {t('evenement.modifier')}
              </button>
              {!annule && (
                <button
                  type="button"
                  className="bouton-compact bouton-danger-discret"
                  onClick={() => window.confirm(t('evenement.annuler_confirmation')) && agir(annulerEvenement(groupId, evenement.id))}
                >
                  {t('evenement.annuler')}
                </button>
              )}
            </div>
          ) : undefined
        }
      />

      <Erreur message={erreur} />

      <div className="grille-bento-groupe">
        <div className="bento-colonne-gauche">
          {(evenement.location_name !== null ||
            evenement.location_address !== null ||
            evenement.arrival_note !== null ||
            evenement.capacity !== null ||
            evenement.source_date_poll_id !== null ||
            evenement.description !== null) && (
            <div className="carte">
              <div className="carte-entete">
                <h3 className="widget-titre">
                  <IconeLieu className="widget-titre-icone icone-indigo" />
                  <span>{t('evenement.details_titre')}</span>
                </h3>
                {evenement.source_date_poll_id !== null && (
                  <a
                    className="lien-entete-widget"
                    href={`#/groupe/${encodeURIComponent(groupId)}/sondage/${encodeURIComponent(evenement.source_date_poll_id)}`}
                  >
                    {t('evenement.sondage_origine')}
                  </a>
                )}
              </div>
              <div className="evenement-details-liste">
                {evenement.location_name !== null && <p>{t('evenement.lieu', { lieu: evenement.location_name })}</p>}
                {evenement.location_address !== null && <p className="discret">{evenement.location_address}</p>}
                {evenement.arrival_note !== null && <p>{t('evenement.arrivee', { note: evenement.arrival_note })}</p>}
                {evenement.capacity !== null && <p>{t('evenement.capacite', { nombre: String(evenement.capacity) })}</p>}
                {evenement.description !== null && <p className="description">{evenement.description}</p>}
              </div>
            </div>
          )}

          <div className="carte">
            <div className="carte-entete">
              <h3>{t('presence.titre')}</h3>
              {presences !== null && (
                <span className="pilule pilule-role-admin">
                  {t('presence.n_attendus', { n: String(presences.compteurs.attendus) })}
                </span>
              )}
            </div>
            {annule ? (
              <p className="discret">{t('presence.evenement_annule')}</p>
            ) : (
              <div className="formulaire">
                <div className="votes-segmentes" role="group" aria-label={t('presence.titre')}>
                  {REPONSES.map((r) => (
                    <button
                      key={r}
                      type="button"
                      className={`vote-btn vote-btn-${r}`}
                      aria-pressed={choix === r}
                      onClick={() => {
                        setChoix(r);
                        if (r === 'no') setInvites(0);
                      }}
                    >
                      {t(`presence.${r}` as const)}
                    </button>
                  ))}
                </div>
                <div className="grille-champs-2">
                  <label>
                    {t('presence.invites')}
                    <input
                      type="number"
                      inputMode="numeric"
                      min={0}
                      max={20}
                      value={invites}
                      disabled={choix === 'no'}
                      onChange={(e) => setInvites(Math.max(0, Math.min(20, Number(e.target.value) || 0)))}
                    />
                  </label>
                  <label>
                    {t('presence.commentaire')}
                    <input type="text" value={commentaire} maxLength={500} onChange={(e) => setCommentaire(e.target.value)} />
                  </label>
                </div>
                <button
                  type="button"
                  className="bouton-primaire"
                  disabled={choix === null}
                  onClick={() =>
                    choix !== null &&
                    agir(
                      repondre(groupId, evenement.id, {
                        status: choix,
                        guests_count: invites,
                        comment: commentaire.trim() === '' ? null : commentaire.trim(),
                      }),
                    )
                  }
                >
                  {t('presence.enregistrer')}
                </button>
              </div>
            )}

            {presences !== null && (
              <div className="bloc-presences-liste">
                <div className="creneau-compteurs">
                  <span className="pilule pilule-statut-yes">{t('presence.n_yes', { n: String(presences.compteurs.yes) })}</span>
                  <span className="pilule pilule-statut-maybe">{t('presence.n_maybe', { n: String(presences.compteurs.maybe) })}</span>
                  <span className="pilule pilule-statut-no">{t('presence.n_no', { n: String(presences.compteurs.no) })}</span>
                </div>
                {presences.reponses.length > 0 && (
                  <ul className="liste-elements">
                    {presences.reponses.map((r) => (
                      <li key={r.membership_id} className="ligne ligne-compacte">
                        <span>
                          {t('presence.ligne', { nom: r.display_name, reponse: t(`presence.${r.status}` as const) })}
                          {r.guests_count > 0 && ` ${t('presence.plus_invites', { n: String(r.guests_count) })}`}
                          {r.comment !== null && ` — ${r.comment}`}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {presences.sans_reponse.length > 0 && (
                  <p className="discret ligne-meta">
                    {`${t('presence.sans_reponse', { n: String(presences.compteurs.sans_reponse) })} : ${presences.sans_reponse.map((m) => m.display_name).join(', ')}`}
                  </p>
                )}
              </div>
            )}
          </div>

          <div className="carte">
            <TachesEvenement groupId={groupId} evenementId={evenement.id} titreEvenement={evenement.title} membres={membres} />
          </div>

          <SectionDepenses
            groupId={groupId}
            evenementId={evenement.id}
            peutCloturer={evenement.peut_modifier}
            membresFournis={membres}
          />

          <div className="carte">
            <div className="carte-entete">
              <h3>{t('organisateurs.titre')}</h3>
            </div>
            <p className="discret">{t('organisateurs.auteur', { nom: evenement.auteur.display_name })}</p>
            {evenement.organisateurs.length === 0 ? (
              <p className="discret">{t('organisateurs.aucun')}</p>
            ) : (
              <ul className="liste-elements">
                {evenement.organisateurs.map((o) => (
                  <li key={o.membership_id} className="ligne ligne-compacte">
                    <span>{o.display_name}</span>
                    {evenement.peut_modifier && (
                      <button
                        type="button"
                        className="bouton-compact bouton-danger-discret"
                        onClick={() => agir(retirerOrganisateur(groupId, evenement.id, o.membership_id))}
                      >
                        {t('organisateurs.retirer')}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {evenement.peut_modifier && candidats.length > 0 && (
              <div className="barre liste-compacte-haut">
                <select aria-label={t('organisateurs.choisir')} value={aAjouter} onChange={(e) => setAAjouter(e.target.value)}>
                  <option value="">{t('organisateurs.choisir')}</option>
                  {candidats.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.display_name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  disabled={aAjouter === ''}
                  onClick={() => {
                    agir(ajouterOrganisateur(groupId, evenement.id, aAjouter));
                    setAAjouter('');
                  }}
                >
                  {t('organisateurs.ajouter')}
                </button>
              </div>
            )}
          </div>
        </div>

        {evenement.thread_id !== null && (
          <div className="bento-colonne-droite">
            <div className="carte">
              <div className="carte-entete">
                <h3 className="widget-titre">
                  <IconeMessage className="widget-titre-icone icone-indigo" />
                  <span>{t('evenement.discussion')}</span>
                </h3>
              </div>
              <FilDiscussion groupId={groupId} filId={evenement.thread_id} />
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
