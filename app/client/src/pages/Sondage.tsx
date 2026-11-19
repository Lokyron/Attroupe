import { useEffect, useRef, useState, type FormEvent } from 'react';
import { instantDepuisHeureLocale } from '../agenda/dates';
import { libelleDateHoraire } from '../agenda/format';
import { lireGroupe } from '../api/groupes';
import { useRechargement } from '../api/rechargement';
import {
  ajouterOptionSondage,
  annulerSondage,
  convertirSondage,
  lireSondage,
  modifierSondage,
  retirerOptionSondage,
  voterOptionSondage,
  type DetailSondage,
  type OptionSondage,
  type ValeurVote,
} from '../api/sondages';
import { useTempsReel } from '../api/tempsReel';
import { ChargementPage } from '../components/ChargementPage';
import { DialogueConfirmation } from '../components/DialogueConfirmation';
import { EnteteGroupe } from '../components/EnteteGroupe';
import { Erreur, messageDe } from '../components/Erreur';
import { IconeEtincelles, IconePoubelle } from '../components/Icones';
import { useLecture } from '../hooks/useLecture';
import { useSoumission } from '../hooks/useSoumission';
import { t, type CleTexte } from '../i18n';

const VOTES: readonly ValeurVote[] = ['yes', 'maybe', 'no'];

/** Détail d'un sondage de dates : jauge visuelle des votes, boutons segmentés tactiles et conversion en événement. */
export function Sondage({ groupId, sondageId }: { groupId: string; sondageId: string }) {
  // Lecture initiale (trois états) ; `sondage` en est la copie locale, rafraîchie par le temps réel sans repasser par le squelette.
  const lecture = useLecture(() => lireSondage(groupId, sondageId), [groupId, sondageId]);
  const [source, setSource] = useState(lecture.donnees);
  const [sondage, setSondage] = useState<DetailSondage | null>(lecture.donnees);
  if (source !== lecture.donnees) {
    setSource(lecture.donnees);
    setSondage(lecture.donnees);
  }
  // Une garde par famille d'écriture : un vote en vol ne bloque pas une clôture, mais deux votes ne partent jamais ensemble.
  const vote = useSoumission();
  const action = useSoumission();
  const ajoutCreneau = useSoumission();
  const champDebut = useRef<HTMLInputElement>(null);
  const [conversion, setConversion] = useState<{ readonly optionId: string | null } | null>(null);
  const [optionARetirer, setOptionARetirer] = useState<string | null>(null);
  const [annulation, setAnnulation] = useState(false);
  const [fuseau, setFuseau] = useState('Europe/Paris');
  const [journee, setJournee] = useState(false);
  const [debut, setDebut] = useState('');
  const [fin, setFin] = useState('');
  const [erreur, setErreur] = useState<string | null>(null);

  const { recharger, planifier } = useRechargement(
    () => lireSondage(groupId, sondageId),
    (lu) => {
      setSondage(lu);
      setErreur(null);
    },
    (err) => setErreur(messageDe(err)),
  );

  useEffect(() => {
    lireGroupe(groupId)
      .then((g) => setFuseau(g.time_zone))
      .catch((err: unknown) => setErreur(messageDe(err)));
  }, [groupId]);

  useTempsReel(groupId, {
    onOuvert: recharger,
    onEvenement: (e) => {
      if (e.ressource === 'sondage' && (e.id === sondageId || e.parent_id === sondageId)) planifier();
    },
  });

  /** Lance une écriture qui renvoie le sondage à jour, sous la garde `garde` (une seule en vol à la fois). */
  const agir = (garde: ReturnType<typeof useSoumission>, fabrique: () => Promise<DetailSondage>): void => {
    setErreur(null);
    garde
      .lancer(() => fabrique().then(setSondage))
      .catch((err: unknown) => setErreur(messageDe(err)));
  };

  const confirmerConversion = (): void => {
    const cible = conversion;
    setConversion(null);
    if (cible === null) return;
    setErreur(null);
    action
      .lancer(() =>
        convertirSondage(groupId, sondageId, cible.optionId === null ? {} : { option_id: cible.optionId }).then(
          ({ sondage: maj, evenementId }) => {
            setSondage(maj);
            window.location.hash = `#/groupe/${encodeURIComponent(groupId)}/evenement/${encodeURIComponent(evenementId)}`;
          },
        ),
      )
      .catch((err: unknown) => setErreur(messageDe(err)));
  };

  const confirmerRetraitOption = (): void => {
    const optionId = optionARetirer;
    setOptionARetirer(null);
    if (optionId === null) return;
    agir(action, () => retirerOptionSondage(groupId, sondageId, optionId));
  };

  const confirmerAnnulation = (): void => {
    setAnnulation(false);
    agir(action, () => annulerSondage(groupId, sondageId));
  };

  const soumettreOption = (e: FormEvent): void => {
    e.preventDefault();
    setErreur(null);
    try {
      const startsAt = journee ? debut : instantDepuisHeureLocale(debut, fuseau);
      const endsAt = fin === '' ? null : journee ? fin : instantDepuisHeureLocale(fin, fuseau);
      ajoutCreneau
        .lancer(() =>
          ajouterOptionSondage(groupId, sondageId, { all_day: journee, starts_at: startsAt, ends_at: endsAt }).then((maj) => {
            setSondage(maj);
            setDebut('');
            setFin('');
          }),
        )
        .catch((err: unknown) => setErreur(messageDe(err)));
    } catch {
      setErreur(t('evenement_form.fuseau_invalide'));
    }
  };

  const retour = `#/groupe/${encodeURIComponent(groupId)}/sondages`;
  if (sondage === null) {
    return (
      <section className="page-groupe-pile">
        <EnteteGroupe groupId={groupId} ongletActif="sondages" lienRetour={{ href: retour, libelle: t('sondage.retour') }} />
        <ChargementPage etat={lecture.etat} erreur={lecture.erreur} onReessayer={lecture.recharger}>
          {null}
        </ChargementPage>
      </section>
    );
  }
  const ouvert = sondage.status === 'open' && (sondage.closes_at === null || new Date(sondage.closes_at).getTime() > Date.now());
  const convertible = sondage.status === 'open' || sondage.status === 'closed';
  // Date limite passée : le sondage est encore « ouvert » côté serveur mais on n'y vote plus.
  const delaiDepasse = sondage.status === 'open' && !ouvert;
  const aDesVoix = sondage.options.some((o) => o.compteurs.yes + o.compteurs.maybe + o.compteurs.no > 0);

  const libelleOption = (o: OptionSondage): string =>
    libelleDateHoraire({ all_day: o.all_day, starts_at: o.starts_at, ends_at: o.ends_at, time_zone: fuseau });

  const statutPilule =
    sondage.status === 'open'
      ? 'pilule pilule-statut-yes'
      : sondage.status === 'converted'
        ? 'pilule pilule-role-admin'
        : sondage.status === 'cancelled'
          ? 'pilule pilule-statut-no'
          : 'pilule';

  return (
    <section className="page-groupe-pile">
      <EnteteGroupe
        groupId={groupId}
        ongletActif="sondages"
        titre={sondage.title}
        lienRetour={{ href: retour, libelle: t('sondage.retour') }}
        meta={
          <>
            <span className={statutPilule}>{t(`sondages.statut_${sondage.status}` as CleTexte)}</span>
            <span className="pilule">{t('sondage.auteur', { nom: sondage.auteur.display_name })}</span>
            {sondage.closes_at !== null && (
              <span className="pilule">
                {t('sondage.cloture_le', {
                  date: libelleDateHoraire({ all_day: false, starts_at: sondage.closes_at, ends_at: null, time_zone: fuseau }),
                })}
              </span>
            )}
          </>
        }
        actions={
          sondage.resulting_event_id !== null ? (
            <a
              className="bouton bouton-primaire"
              href={`#/groupe/${encodeURIComponent(groupId)}/evenement/${encodeURIComponent(sondage.resulting_event_id)}`}
            >
              {t('sondage.voir_evenement')}
            </a>
          ) : undefined
        }
      />

      <Erreur message={erreur} />

      {(sondage.description !== null || convertible || sondage.status === 'open' || sondage.status === 'closed') && (
        <div className="carte">
          {sondage.description !== null && <p className="description">{sondage.description}</p>}
          {delaiDepasse && (
            <p className="discret" role="status">
              {t('erreur.sondage.ferme')}
            </p>
          )}
          {(sondage.status === 'open' || sondage.status === 'closed' || convertible) && (
            <div className="barre">
              {convertible && sondage.options.length > 0 && (
                <button
                  type="button"
                  className="bouton-primaire"
                  disabled={!aDesVoix || action.enCours}
                  onClick={() => setConversion({ optionId: null })}
                >
                  {t('confirm.sondage.convertir.action')}
                </button>
              )}
              {sondage.status === 'open' && ouvert && (
                <button
                  type="button"
                  disabled={action.enCours}
                  onClick={() => agir(action, () => modifierSondage(groupId, sondage.id, { status: 'closed' }))}
                >
                  {t('sondage.cloturer')}
                </button>
              )}
              {sondage.status === 'closed' && (
                <button
                  type="button"
                  disabled={action.enCours}
                  onClick={() => agir(action, () => modifierSondage(groupId, sondage.id, { status: 'open' }))}
                >
                  {t('sondage.rouvrir')}
                </button>
              )}
              {convertible && (
                <button type="button" className="bouton-danger-discret" disabled={action.enCours} onClick={() => setAnnulation(true)}>
                  {t('sondage.annuler')}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      <div className="liste-creneaux-sondage">
        {sondage.options.length === 0 ? (
          <div className="carte">
            <div className="etat-vide">
              <p>{t('sondage.aucune_option')}</p>
              {ouvert && (
                <button type="button" onClick={() => champDebut.current?.focus()}>
                  {t('sondage.ajouter_option')}
                </button>
              )}
            </div>
          </div>
        ) : (
          sondage.options.map((o) => {
            const enTete = sondage.option_gagnante_id === o.id;
            const totalVotes = o.compteurs.yes + o.compteurs.maybe + o.compteurs.no;
            const pctYes = totalVotes === 0 ? 0 : Math.round((o.compteurs.yes / totalVotes) * 100);
            const pctMaybe = totalVotes === 0 ? 0 : Math.round((o.compteurs.maybe / totalVotes) * 100);
            const pctNo = totalVotes === 0 ? 0 : Math.max(0, 100 - pctYes - pctMaybe);

            return (
              <div key={o.id} className={`carte carte-creneau${enTete ? ' carte-creneau-gagnant' : ''}`}>
                <div className="creneau-entete">
                  <div className="creneau-titre-groupe">
                    <strong className="creneau-libelle">{libelleOption(o)}</strong>
                    {enTete && (
                      <span className="pilule pilule-statut-yes">
                        <IconeEtincelles className="icone-mini" />
                        <span>{t('sondage.en_tete')}</span>
                      </span>
                    )}
                  </div>
                  <div className="creneau-actions-haut">
                    {convertible && (
                      <button
                        type="button"
                        className="bouton-compact"
                        disabled={action.enCours}
                        aria-label={`${t('confirm.sondage.convertir.action')} : ${libelleOption(o)}`}
                        onClick={() => setConversion({ optionId: o.id })}
                      >
                        {t('confirm.sondage.convertir.action')}
                      </button>
                    )}
                    {ouvert && (
                      <button
                        type="button"
                        className="bouton-icone-discret"
                        aria-label={t('sondage.retirer_option')}
                        disabled={action.enCours}
                        onClick={() => setOptionARetirer(o.id)}
                      >
                        <IconePoubelle className="icone-mini" />
                      </button>
                    )}
                  </div>
                </div>

                <div className="jauge-votes" aria-hidden="true">
                  {pctYes > 0 && <div className="jauge-segment jauge-yes" style={{ width: `${pctYes}%` }} />}
                  {pctMaybe > 0 && <div className="jauge-segment jauge-maybe" style={{ width: `${pctMaybe}%` }} />}
                  {pctNo > 0 && <div className="jauge-segment jauge-no" style={{ width: `${pctNo}%` }} />}
                </div>

                <div className="creneau-compteurs">
                  <span className="pilule pilule-statut-yes">{t('sondage.barre_oui', { n: String(o.compteurs.yes) })}</span>
                  <span className="pilule pilule-statut-maybe">{t('sondage.barre_peut_etre', { n: String(o.compteurs.maybe) })}</span>
                  <span className="pilule pilule-statut-no">{t('sondage.barre_non', { n: String(o.compteurs.no) })}</span>
                </div>

                <p className="discret ligne-meta">
                  {o.votes.length === 0
                    ? t('sondage.aucun_vote')
                    : o.votes
                        .map((v) =>
                          t('sondage.votants_ligne', {
                            nom: v.display_name,
                            vote: t(`sondage.vote_${v.value}` as const),
                          }),
                        )
                        .join(', ')}
                </p>

                <div className="votes-segmentes" role="group" aria-label={t('sondage.colonne_mon_vote')}>
                  {VOTES.map((v) => (
                    <button
                      key={v}
                      type="button"
                      className={`vote-btn vote-btn-${v}`}
                      disabled={!ouvert || vote.enCours}
                      aria-pressed={o.mon_vote === v}
                      onClick={() => agir(vote, () => voterOptionSondage(groupId, sondage.id, o.id, v))}
                    >
                      {t(`sondage.vote_${v}` as const)}
                    </button>
                  ))}
                </div>
              </div>
            );
          })
        )}
      </div>

      {ouvert && (
        <div className="carte">
          <div className="carte-entete">
            <h3>{t('sondage.ajouter_option_titre')}</h3>
          </div>
          <form className="formulaire" onSubmit={soumettreOption}>
            <label className="ligne-case">
              <input
                type="checkbox"
                checked={journee}
                onChange={(e) => {
                  setJournee(e.target.checked);
                  setDebut('');
                  setFin('');
                }}
              />
              {t('sondages.creneau_journee')}
            </label>
            <div className="grille-champs-2">
              <label>
                {t('sondages.creneau_debut')}
                <input
                  ref={champDebut}
                  type={journee ? 'date' : 'datetime-local'}
                  value={debut}
                  onChange={(e) => setDebut(e.target.value)}
                  required
                />
              </label>
              <label>
                {t('sondages.creneau_fin')}
                <input
                  type={journee ? 'date' : 'datetime-local'}
                  value={fin}
                  min={debut}
                  onChange={(e) => setFin(e.target.value)}
                />
              </label>
            </div>
            <button type="submit" disabled={debut === '' || ajoutCreneau.enCours}>
              {ajoutCreneau.enCours ? t('commun.envoi') : t('sondage.ajouter_option')}
            </button>
          </form>
        </div>
      )}

      {/* Toujours montés (le focus revient à l'élément ouvrant). */}
      <DialogueConfirmation
        ouvert={optionARetirer !== null}
        titre={t('confirm.sondage.retirer_creneau.titre')}
        consequence={t('confirm.sondage.retirer_creneau.consequence')}
        reversible={false}
        libelleConfirmer={t('confirm.sondage.retirer_creneau.action')}
        danger
        onConfirmer={confirmerRetraitOption}
        onAnnuler={() => setOptionARetirer(null)}
      />
      <DialogueConfirmation
        ouvert={conversion !== null}
        titre={t('confirm.sondage.convertir.titre')}
        consequence={t('confirm.sondage.convertir.consequence')}
        reversible={false}
        libelleConfirmer={t('confirm.sondage.convertir.action')}
        danger={false}
        onConfirmer={confirmerConversion}
        onAnnuler={() => setConversion(null)}
      />
      <DialogueConfirmation
        ouvert={annulation}
        titre={t('confirm.sondage.annuler.titre')}
        consequence={t('confirm.sondage.annuler.consequence')}
        reversible={false}
        libelleConfirmer={t('confirm.sondage.annuler.action')}
        danger
        onConfirmer={confirmerAnnulation}
        onAnnuler={() => setAnnulation(false)}
      />
    </section>
  );
}
