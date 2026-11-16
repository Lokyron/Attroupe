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
import { FormulaireEvenement } from '../components/FormulaireEvenement';
import { Erreur, messageDe } from '../components/Erreur';
import { TachesEvenement } from '../components/TachesEvenement';
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
    <section>
      <h2>{t('evenement_form.titre_creation')}</h2>
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
    </section>
  );
}

/** Détail d'un événement : horaire, ma réponse, compteurs, organisateurs, modification et annulation (pour qui en a le droit). */
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
      <section>
        <h2>{t('evenement_form.titre_modification')}</h2>
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
      </section>
    );
  }

  return (
    <section>
      <p>
        <a href={agenda}>{t('evenement.retour_agenda')}</a>
      </p>
      <h2>{evenement.title}</h2>
      {annule && <p role="status" className="badge-annule">{t('agenda.annule')}</p>}
      <p>{libelleDateHoraire(evenement)}</p>
      {evenement.location_name !== null && <p>{t('evenement.lieu', { lieu: evenement.location_name })}</p>}
      {evenement.location_address !== null && <p>{evenement.location_address}</p>}
      {evenement.arrival_note !== null && <p>{t('evenement.arrivee', { note: evenement.arrival_note })}</p>}
      {evenement.capacity !== null && <p>{t('evenement.capacite', { nombre: String(evenement.capacity) })}</p>}
      {evenement.description !== null && <p className="description">{evenement.description}</p>}
      <Erreur message={erreur} />

      {evenement.peut_modifier && (
        <div className="barre">
          <button type="button" onClick={() => setEdition(true)}>
            {t('evenement.modifier')}
          </button>
          {!annule && (
            <button type="button" onClick={() => window.confirm(t('evenement.annuler_confirmation')) && agir(annulerEvenement(groupId, evenement.id))}>
              {t('evenement.annuler')}
            </button>
          )}
        </div>
      )}

      <h3>{t('presence.titre')}</h3>
      {annule ? (
        <p>{t('presence.evenement_annule')}</p>
      ) : (
        <div className="formulaire">
          <div className="barre" role="group" aria-label={t('presence.titre')}>
            {REPONSES.map((r) => (
              <button
                key={r}
                type="button"
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
          <label>
            {t('presence.invites')}
            <input type="number" inputMode="numeric" min={0} max={20} value={invites} disabled={choix === 'no'} onChange={(e) => setInvites(Math.max(0, Math.min(20, Number(e.target.value) || 0)))} />
          </label>
          <label>
            {t('presence.commentaire')}
            <input type="text" value={commentaire} maxLength={500} onChange={(e) => setCommentaire(e.target.value)} />
          </label>
          <button
            type="button"
            disabled={choix === null}
            onClick={() => choix !== null && agir(repondre(groupId, evenement.id, { status: choix, guests_count: invites, comment: commentaire.trim() === '' ? null : commentaire.trim() }))}
          >
            {t('presence.enregistrer')}
          </button>
        </div>
      )}

      {presences !== null && (
        <>
          <h3>{t('presence.compteurs')}</h3>
          <ul>
            <li>{t('presence.n_yes', { n: String(presences.compteurs.yes) })}</li>
            <li>{t('presence.n_maybe', { n: String(presences.compteurs.maybe) })}</li>
            <li>{t('presence.n_no', { n: String(presences.compteurs.no) })}</li>
            <li>
              <strong>{t('presence.n_attendus', { n: String(presences.compteurs.attendus) })}</strong>
            </li>
          </ul>
          <ul>
            {presences.reponses.map((r) => (
              <li key={r.membership_id}>
                {t('presence.ligne', { nom: r.display_name, reponse: t(`presence.${r.status}` as const) })}
                {r.guests_count > 0 && ` ${t('presence.plus_invites', { n: String(r.guests_count) })}`}
                {r.comment !== null && ` — ${r.comment}`}
              </li>
            ))}
          </ul>
          <h4>{t('presence.sans_reponse', { n: String(presences.compteurs.sans_reponse) })}</h4>
          <p>{presences.sans_reponse.map((m) => m.display_name).join(', ')}</p>
        </>
      )}

      <TachesEvenement groupId={groupId} evenementId={evenement.id} titreEvenement={evenement.title} membres={membres} />

      <h3>{t('organisateurs.titre')}</h3>
      <p>{t('organisateurs.auteur', { nom: evenement.auteur.display_name })}</p>
      {evenement.organisateurs.length === 0 && <p>{t('organisateurs.aucun')}</p>}
      <ul>
        {evenement.organisateurs.map((o) => (
          <li key={o.membership_id}>
            {o.display_name}
            {evenement.peut_modifier && (
              <button type="button" onClick={() => agir(retirerOrganisateur(groupId, evenement.id, o.membership_id))}>
                {t('organisateurs.retirer')}
              </button>
            )}
          </li>
        ))}
      </ul>
      {evenement.peut_modifier && candidats.length > 0 && (
        <div className="barre">
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
    </section>
  );
}
