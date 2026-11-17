import { useEffect, useState, type FormEvent } from 'react';
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
import { EnteteGroupe } from '../components/EnteteGroupe';
import { Erreur, messageDe } from '../components/Erreur';
import { IconeEtincelles, IconePoubelle } from '../components/Icones';
import { t, type CleTexte } from '../i18n';

const VOTES: readonly ValeurVote[] = ['yes', 'maybe', 'no'];

/** Détail d'un sondage de dates : jauge visuelle des votes, boutons segmentés tactiles et conversion en événement. */
export function Sondage({ groupId, sondageId }: { groupId: string; sondageId: string }) {
  const [sondage, setSondage] = useState<DetailSondage | null>(null);
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
    recharger();
    lireGroupe(groupId)
      .then((g) => setFuseau(g.time_zone))
      .catch((err: unknown) => setErreur(messageDe(err)));
  }, [groupId, recharger]);

  useTempsReel(groupId, {
    onOuvert: recharger,
    onEvenement: (e) => {
      if (e.ressource === 'sondage' && (e.id === sondageId || e.parent_id === sondageId)) planifier();
    },
  });

  const agir = (action: Promise<DetailSondage>): void => {
    setErreur(null);
    action.then(setSondage).catch((err: unknown) => setErreur(messageDe(err)));
  };

  const convertir = (optionId?: string): void => {
    setErreur(null);
    convertirSondage(groupId, sondageId, optionId === undefined ? {} : { option_id: optionId })
      .then(({ sondage: maj, evenementId }) => {
        setSondage(maj);
        window.location.hash = `#/groupe/${encodeURIComponent(groupId)}/evenement/${encodeURIComponent(evenementId)}`;
      })
      .catch((err: unknown) => setErreur(messageDe(err)));
  };

  const soumettreOption = (e: FormEvent): void => {
    e.preventDefault();
    setErreur(null);
    try {
      const startsAt = journee ? debut : instantDepuisHeureLocale(debut, fuseau);
      const endsAt = fin === '' ? null : journee ? fin : instantDepuisHeureLocale(fin, fuseau);
      ajouterOptionSondage(groupId, sondageId, { all_day: journee, starts_at: startsAt, ends_at: endsAt })
        .then((maj) => {
          setSondage(maj);
          setDebut('');
          setFin('');
        })
        .catch((err: unknown) => setErreur(messageDe(err)));
    } catch {
      setErreur(t('evenement_form.fuseau_invalide'));
    }
  };

  if (sondage === null) return <Erreur message={erreur} />;
  const ouvert = sondage.status === 'open' && (sondage.closes_at === null || new Date(sondage.closes_at).getTime() > Date.now());
  const convertible = sondage.status === 'open' || sondage.status === 'closed';
  const retour = `#/groupe/${encodeURIComponent(groupId)}/sondages`;

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
          {(sondage.status === 'open' || sondage.status === 'closed' || convertible) && (
            <div className="barre">
              {convertible && sondage.options.length > 0 && (
                <button type="button" className="bouton-primaire" onClick={() => convertir()}>
                  {t('sondage.convertir_gagnant')}
                </button>
              )}
              {sondage.status === 'open' && (
                <button type="button" onClick={() => agir(modifierSondage(groupId, sondage.id, { status: 'closed' }))}>
                  {t('sondage.cloturer')}
                </button>
              )}
              {sondage.status === 'closed' && (
                <button type="button" onClick={() => agir(modifierSondage(groupId, sondage.id, { status: 'open' }))}>
                  {t('sondage.rouvrir')}
                </button>
              )}
              {convertible && (
                <button
                  type="button"
                  className="bouton-danger-discret"
                  onClick={() => window.confirm(t('sondage.annuler_confirmation')) && agir(annulerSondage(groupId, sondage.id))}
                >
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
            <p className="discret">{t('sondage.aucune_option')}</p>
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
                      <button type="button" className="bouton-compact" onClick={() => convertir(o.id)}>
                        {t('sondage.convertir_option')}
                      </button>
                    )}
                    {ouvert && (
                      <button
                        type="button"
                        className="bouton-icone-discret"
                        aria-label={t('sondage.retirer_option')}
                        onClick={() => agir(retirerOptionSondage(groupId, sondage.id, o.id))}
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
                      disabled={!ouvert}
                      aria-pressed={o.mon_vote === v}
                      onClick={() => agir(voterOptionSondage(groupId, sondage.id, o.id, v))}
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
            <button type="submit" disabled={debut === ''}>
              {t('sondage.ajouter_option')}
            </button>
          </form>
        </div>
      )}
    </section>
  );
}
