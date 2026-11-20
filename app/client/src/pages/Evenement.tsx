import { useCallback, useState } from 'react';
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
import { listerMembres, type Membre } from '../api/groupes';
import { libelleDateHoraire } from '../agenda/format';
import { ChargementPage, SqueletteCarte } from '../components/ChargementPage';
import { DialogueConfirmation } from '../components/DialogueConfirmation';
import { EnteteGroupe } from '../components/EnteteGroupe';
import { Erreur, messageDe } from '../components/Erreur';
import { FilDiscussion } from '../components/FilDiscussion';
import { useGroupe } from '../components/FournisseurGroupe';
import { FormulaireEvenement } from '../components/FormulaireEvenement';
import { IconeCalendrier, IconeLieu, IconeMessage } from '../components/Icones';
import { TachesEvenement } from '../components/TachesEvenement';
import { useLecture } from '../hooks/useLecture';
import { useSoumission } from '../hooks/useSoumission';
import { SectionDepenses } from './Depenses';
import { t } from '../i18n';

const REPONSES: readonly ReponsePresence[] = ['yes', 'maybe', 'no'];

/** Création d'un événement : le formulaire, puis le détail du nouvel événement. */
export function NouvelEvenement({ groupId }: { groupId: string }) {
  const { groupe, etat, erreur, rechargerGroupe } = useGroupe();
  const agenda = `#/groupe/${encodeURIComponent(groupId)}/agenda`;
  return (
    <section className="page-groupe-pile">
      <EnteteGroupe
        ongletActif="agenda"
        titre={t('evenement_form.titre_creation')}
        lienRetour={{ href: agenda, libelle: t('evenement.retour_agenda') }}
      />
      <ChargementPage etat={etat} erreur={erreur} onReessayer={rechargerGroupe} squelette={<SqueletteCarte />}>
        {groupe !== null && (
      <div className="carte">
        <FormulaireEvenement
          groupId={groupId}
          fuseauParDefaut={groupe.time_zone}
          onEnregistre={(e) => {
            window.location.hash = `#/groupe/${encodeURIComponent(groupId)}/evenement/${encodeURIComponent(e.id)}`;
          }}
          onAnnule={() => {
            window.location.hash = agenda;
          }}
        />
      </div>
        )}
      </ChargementPage>
    </section>
  );
}

interface DonneesEvenement {
  evenement: DetailEvenement;
  presences: Presences;
  membres: Membre[];
}

/** Détail d'un événement : lecture initiale à trois états (squelette, erreur avec reprise, contenu) ; le contenu vit dans `CorpsEvenement`. */
export function Evenement({ groupId, evenementId }: { groupId: string; evenementId: string }) {
  const { donnees, etat, erreur, recharger } = useLecture<DonneesEvenement>(
    () =>
      Promise.all([lireEvenement(groupId, evenementId), lirePresences(groupId, evenementId), listerMembres(groupId)]).then(
        ([evenement, presences, membres]) => ({ evenement, presences, membres }),
      ),
    [groupId, evenementId],
  );
  if (etat !== 'pret' || donnees === null) {
    return (
      <section className="page-groupe-pile">
        <EnteteGroupe
          ongletActif="agenda"
          lienRetour={{ href: `#/groupe/${encodeURIComponent(groupId)}/agenda`, libelle: t('evenement.retour_agenda') }}
        />
        <ChargementPage etat={etat} erreur={erreur} onReessayer={recharger} squelette={<SqueletteCarte />}>
          {null}
        </ChargementPage>
      </section>
    );
  }
  return <CorpsEvenement groupId={groupId} initial={donnees} />;
}

/** Contenu d'un événement : 2 colonnes sur desktop (détails, RSVP, tâches, dépenses d'un côté ; discussion de l'autre). */
function CorpsEvenement({ groupId, initial }: { groupId: string; initial: DonneesEvenement }) {
  const [evenement, setEvenement] = useState<DetailEvenement>(initial.evenement);
  const [presences, setPresences] = useState<Presences>(initial.presences);
  const membres = initial.membres;
  const [edition, setEdition] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const [choix, setChoix] = useState<ReponsePresence | null>(initial.evenement.ma_presence?.status ?? null);
  // `invites` reste une chaîne : effacer le champ ne doit pas le forcer à 0 sous les doigts de l'utilisateur.
  const [invites, setInvites] = useState(String(initial.evenement.ma_presence?.guests_count ?? 0));
  const [commentaire, setCommentaire] = useState(initial.evenement.ma_presence?.comment ?? '');
  const [aAjouter, setAAjouter] = useState('');
  const [annulationOuverte, setAnnulationOuverte] = useState(false);
  const [aRetirer, setARetirer] = useState<{ id: string; nom: string } | null>(null);
  const [reponseEnregistree, setReponseEnregistree] = useState(false);
  // UNE SEULE garde pour les boutons de statut ET le bouton « Enregistrer » du bloc dépliable :
  // deux instances laissaient partir deux requêtes concurrentes, et c'est la dernière réponse
  // arrivée qui gagnait à l'écran, pas la dernière demandée.
  const reponse = useSoumission();
  const action = useSoumission();
  const evenementId = evenement.id;

  const adopter = useCallback((e: DetailEvenement): void => {
    setEvenement(e);
    setChoix(e.ma_presence?.status ?? null);
    setInvites(String(e.ma_presence?.guests_count ?? 0));
    setCommentaire(e.ma_presence?.comment ?? '');
  }, []);

  /** Applique une écriture sur l'événement (annulation, organisateurs) puis relit les présences ; l'erreur remonte à l'appelant. */
  const agir = (ecriture: () => Promise<DetailEvenement>): Promise<void> => {
    setErreur(null);
    return ecriture().then(async (e) => {
      adopter(e);
      setPresences(await lirePresences(groupId, evenementId));
    });
  };

  /**
   * Enregistre la réponse. Le nouveau statut s'affiche tout de suite (optimiste) et revient en arrière si le serveur refuse.
   * L'état n'est touché qu'une fois la garde de double soumission franchie : un clic ignoré ne doit rien changer.
   */
  const enregistrerReponse = (soumission: ReturnType<typeof useSoumission>, statut: ReponsePresence, nombreInvites: string, texteCommentaire: string): void => {
    const avant = { choix, invites, commentaire };
    const guests = statut === 'no' ? 0 : Math.max(0, Math.min(20, Number(nombreInvites) || 0));
    soumission
      .lancer(async () => {
        setErreur(null);
        setReponseEnregistree(false);
        setChoix(statut);
        setInvites(String(guests));
        // Seul l'ÉCHEC DE L'ENVOI justifie un retour arrière. La relecture de la liste des présences
        // est en dehors du `try` pour cette raison : si elle échouait alors que `repondre` a réussi,
        // remettre l'ancien choix afficherait « Je ne viens pas » là où le serveur a « Je viens ».
        let e;
        try {
          e = await repondre(groupId, evenementId, {
            status: statut,
            guests_count: guests,
            comment: texteCommentaire.trim() === '' ? null : texteCommentaire.trim(),
          });
        } catch (err: unknown) {
          setChoix(avant.choix);
          setInvites(avant.invites);
          setCommentaire(avant.commentaire);
          throw err;
        }
        adopter(e);
        setReponseEnregistree(true);
        setPresences(await lirePresences(groupId, evenementId));
      })
      .catch((err: unknown) => setErreur(messageDe(err)));
  };

  const annule = evenement.status === 'cancelled';
  const agenda = `#/groupe/${encodeURIComponent(groupId)}/agenda`;
  const dejaOrganisateurs = new Set(evenement.organisateurs.map((o) => o.membership_id));
  const candidats = membres.filter((m) => m.status === 'active' && !dejaOrganisateurs.has(m.id));

  if (edition) {
    return (
      <section className="page-groupe-pile">
        <EnteteGroupe
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
                  onClick={() => setAnnulationOuverte(true)}
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
                      disabled={reponse.enCours}
                      onClick={() => enregistrerReponse(reponse, r, invites, commentaire)}
                    >
                      {t(`presence.${r}` as const)}
                    </button>
                  ))}
                </div>
                <p role="status" className="discret">
                  {reponse.enCours
                    ? t('commun.enregistrement')
                    : reponseEnregistree && choix !== null
                      ? `${t('presence.titre')} : ${t(`presence.${choix}` as const)}`
                      : ''}
                </p>
                <details>
                  <summary>{`${t('presence.invites')} · ${t('presence.commentaire')}`}</summary>
                  <div className="grille-champs-2">
                    <label>
                      {t('presence.invites')}
                      <input
                        type="number"
                        inputMode="numeric"
                        min={0}
                        max={20}
                        value={choix === 'no' ? '0' : invites}
                        disabled={choix === 'no'}
                        aria-describedby="aide-invites"
                        onChange={(e) => setInvites(e.target.value)}
                      />
                      {/* La contrainte et la raison du champ grisé sont dites AVANT l'erreur. */}
                      <small id="aide-invites" className="texte-doux">
                        {choix === 'no' ? t('presence.invites_hors_sujet') : t('presence.invites_max')}
                      </small>
                    </label>
                    <label>
                      {t('presence.commentaire')}
                      <input type="text" value={commentaire} maxLength={500} onChange={(e) => setCommentaire(e.target.value)} />
                    </label>
                  </div>
                  <button
                    type="button"
                    className="bouton-primaire"
                    disabled={choix === null || reponse.enCours}
                    onClick={() => choix !== null && enregistrerReponse(reponse, choix, invites, commentaire)}
                  >
                    {reponse.enCours ? t('commun.enregistrement') : t('presence.enregistrer')}
                  </button>
                </details>
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
                        onClick={() => setARetirer({ id: o.membership_id, nom: o.display_name })}
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
                  disabled={aAjouter === '' || action.enCours}
                  onClick={() => {
                    action
                      .lancer(() => agir(() => ajouterOrganisateur(groupId, evenement.id, aAjouter)).then(() => setAAjouter('')))
                      .catch((err: unknown) => setErreur(messageDe(err)));
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
              <FilDiscussion key={`${groupId}/${evenement.thread_id}`} groupId={groupId} filId={evenement.thread_id} />
            </div>
          </div>
        )}
      </div>

      <DialogueConfirmation
        ouvert={annulationOuverte}
        titre={t('confirm.evenement.annuler.titre')}
        consequence={t('confirm.evenement.annuler.consequence')}
        reversible={false}
        libelleConfirmer={t('confirm.evenement.annuler.action')}
        // Sans ce libellé, le bouton de refus s'appelle « Annuler » dans un dialogue qui demande
        // d'annuler un événement : cliquer « Annuler » signifierait alors « ne pas annuler ».
        libelleAnnuler={t('confirm.evenement.annuler.garder')}
        danger
        onConfirmer={() => {
          setAnnulationOuverte(false);
          action.lancer(() => agir(() => annulerEvenement(groupId, evenement.id))).catch((err: unknown) => setErreur(messageDe(err)));
        }}
        onAnnuler={() => setAnnulationOuverte(false)}
      />
      <DialogueConfirmation
        ouvert={aRetirer !== null}
        titre={t('confirm.organisateurs.retirer.titre', { nom: aRetirer?.nom ?? '' })}
        consequence={t('confirm.organisateurs.retirer.consequence')}
        reversible
        libelleConfirmer={t('confirm.organisateurs.retirer.action')}
        danger={false}
        onConfirmer={() => {
          const cible = aRetirer;
          setARetirer(null);
          if (cible === null) return;
          action.lancer(() => agir(() => retirerOrganisateur(groupId, evenement.id, cible.id))).catch((err: unknown) => setErreur(messageDe(err)));
        }}
        onAnnuler={() => setARetirer(null)}
      />
    </section>
  );
}
