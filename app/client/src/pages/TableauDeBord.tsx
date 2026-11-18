import { useEffect, useState, type ReactNode } from 'react';
import {
  ajouterJours,
  aujourdhui,
  grilleMois,
  jourDeDebut,
  joursDe,
  joursDeSemaine,
  moisVoisin,
} from '../agenda/dates';
import { libelleHoraire, libelleJour, libelleJourCourt, libelleMois } from '../agenda/format';
import type { Moi } from '../api/groupes';
import {
  lireTableauDeBord,
  type DonneesTableauDeBord,
  type StatutPresenceTableau,
} from '../api/tableau-de-bord';
import { Erreur, messageDe } from '../components/Erreur';
import {
  IconeBalance,
  IconeCalendrier,
  IconeCalendrierPlus,
  IconeCamera,
  IconeEtincelles,
  IconeGroupes,
  IconeLieu,
  IconeListe,
  IconePlus,
  IconeRecu,
} from '../components/Icones';
import { t, type CleTexte } from '../i18n';

type FiltreCalendrier = 'tous' | 'groupes' | 'perso';
type VueCalendrier = 'liste' | 'semaine' | 'mois';

const VUES_CALENDRIER: readonly VueCalendrier[] = ['liste', 'semaine', 'mois'];
const COULEURS_GROUPES = ['indigo', 'cyan', 'violet', 'emeraude', 'ambre', 'rose'] as const;
type CouleurGroupe = (typeof COULEURS_GROUPES)[number];

type ElementCalendrier =
  | {
      readonly sorte: 'groupe';
      readonly id: string;
      readonly group_id: string;
      readonly group_name: string;
      readonly title: string;
      readonly starts_at: string;
      readonly ends_at: string | null;
      readonly all_day: boolean;
      readonly time_zone: string;
      readonly location_name: string | null;
      readonly mon_statut: StatutPresenceTableau;
    }
  | {
      readonly sorte: 'perso';
      readonly id: string;
      readonly title: string;
      readonly starts_at: string;
      readonly ends_at: string | null;
      readonly all_day: boolean;
      readonly time_zone: string;
      readonly location_name: string | null;
    };

function vueInitialeCalendrier(): VueCalendrier {
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia('(min-width: 640px)').matches ? 'mois' : 'liste';
  }
  return 'liste';
}

function calculerFenetre(vue: VueCalendrier, ancreJour: string): { du: string; au: string } | undefined {
  if (vue === 'liste') return undefined;
  const jours = vue === 'mois' ? grilleMois(ancreJour).flat() : joursDeSemaine(ancreJour);
  return {
    du: ajouterJours(jours[0] ?? ancreJour, -1),
    au: ajouterJours(jours[jours.length - 1] ?? ancreJour, 1),
  };
}

function lienElementCalendrier(el: ElementCalendrier): string {
  return el.sorte === 'groupe'
    ? `#/groupe/${encodeURIComponent(el.group_id)}/evenement/${encodeURIComponent(el.id)}`
    : '#/compte';
}

function libellePastilleCalendrier(el: ElementCalendrier): string {
  return el.sorte === 'groupe'
    ? t('tableau.pastille_groupe', { groupe: el.group_name, titre: el.title })
    : t('tableau.pastille_perso', { titre: el.title });
}

/**
 * Même comportement que `formaterMontant` de `Depenses.tsx` : l'exposant est celui de la devise (lu dans Intl,
 * qui connaît les exposants ISO 4217), et non un cas particulier codé en dur. À factoriser dans `lib/`.
 */
function formaterMontant(montantMineur: number, devise: string, avecSigne = false): string {
  const exposant = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: devise }).resolvedOptions()
    .maximumFractionDigits ?? 2;
  const valeur = montantMineur / 10 ** exposant;
  const formate = new Intl.NumberFormat('fr-FR', {
    style: 'currency',
    currency: devise,
    minimumFractionDigits: exposant,
    maximumFractionDigits: exposant,
  }).format(valeur);
  if (avecSigne && montantMineur > 0) return `+${formate}`;
  return formate;
}

/**
 * Date d'un événement dans SON fuseau (comme les vignettes et `jourDeDebut`), jamais celui du navigateur.
 * Un événement « toute la journée » est une date sans heure, lue en UTC : sinon, sous un fuseau négatif,
 * le jour affiché serait la veille.
 */
function formaterDateEvenement(iso: string, touteLaJournee: boolean, fuseau: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  if (touteLaJournee) {
    const jour = new Intl.DateTimeFormat('fr-FR', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      timeZone: 'UTC',
    }).format(date);
    return `${jour} · ${t('tableau.journee_entiere')}`;
  }
  return new Intl.DateTimeFormat('fr-FR', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: fuseau,
  }).format(date);
}

/** Date AAAA-MM-JJ d'une dépense (sans heure) : lue en UTC pour ne pas glisser d'un jour selon le fuseau. */
function formaterDateCourte(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat('fr-FR', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(date);
}

function formaterDateRelative(el: ElementCalendrier, jourAujourdHui: string): string {
  const jour = jourDeDebut(el);
  const horaire = el.all_day ? t('tableau.journee_entiere') : libelleHoraire(el);
  if (jour === jourAujourdHui) return `${t('tableau.aujourdhui')} · ${horaire}`;
  if (jour === ajouterJours(jourAujourdHui, 1)) return `${t('tableau.demain')} · ${horaire}`;
  return formaterDateEvenement(el.starts_at, el.all_day, el.time_zone);
}

function partiesVignetteDate(el: ElementCalendrier): { mois: string; jour: string } {
  const isoJour = jourDeDebut(el);
  const date = new Date(`${isoJour}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return { mois: '---', jour: '--' };
  const mois = new Intl.DateTimeFormat('fr-FR', { month: 'short', timeZone: 'UTC' })
    .format(date)
    .replace('.', '')
    .toUpperCase();
  const jour = String(Number(isoJour.slice(8, 10)));
  return { mois, jour };
}

function cleStatutCompact(statut: StatutPresenceTableau): CleTexte {
  if (statut === 'yes') return 'tableau.statut_confirme';
  if (statut === 'maybe') return 'tableau.statut_peut_etre';
  if (statut === 'no') return 'tableau.statut_decline';
  return 'tableau.statut_a_valider';
}

function badgeMoisCourt(ancre: string): string {
  const date = new Date(`${ancre.slice(0, 7)}-01T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return ancre.slice(0, 7);
  return new Intl.DateTimeFormat('fr-FR', { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(date);
}

/** Tableau de bord d'accueil de l'utilisateur connecté. */
export function TableauDeBord({ moi, onNouveauGroupe }: { moi: Moi; onNouveauGroupe?: () => void }) {
  const [donnees, setDonnees] = useState<DonneesTableauDeBord | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [filtreGroupe, setFiltreGroupe] = useState<string>('');
  const [filtreCalendrier, setFiltreCalendrier] = useState<FiltreCalendrier>('tous');
  const [vueCalendrier, setVueCalendrier] = useState<VueCalendrier>(vueInitialeCalendrier);
  const [ancre, setAncre] = useState<string>(aujourdhui);
  const [jourMobileSelectionne, setJourMobileSelectionne] = useState<string | null>(null);
  // Incrémenté par « Réessayer » : relance l'effet de chargement sans changer de fenêtre.
  const [tentative, setTentative] = useState(0);
  const [fenetreChargee, setFenetreChargee] = useState<'defaut' | { readonly du: string; readonly au: string } | null>(null);

  useEffect(() => {
    setErreur(null);
    const fenetreDemandee = calculerFenetre(vueCalendrier, ancre);
    const dejaCouvert =
      fenetreDemandee === undefined
        ? fenetreChargee === 'defaut'
        : fenetreChargee !== null &&
          fenetreChargee !== 'defaut' &&
          fenetreChargee.du <= fenetreDemandee.du &&
          fenetreDemandee.au <= fenetreChargee.au;

    if (dejaCouvert) return;

    let actif = true;
    lireTableauDeBord(fenetreDemandee)
      .then((res) => {
        if (!actif) return;
        setDonnees(res);
        setFenetreChargee(fenetreDemandee ?? 'defaut');
      })
      .catch((err: unknown) => {
        if (actif) setErreur(messageDe(err));
      });
    return () => {
      actif = false;
    };
  }, [vueCalendrier, ancre, fenetreChargee, tentative]);

  const couleurParGroupe = new Map<string, CouleurGroupe>();
  (donnees?.groupes ?? moi.groupes).forEach((g, idx) => {
    couleurParGroupe.set(g.group_id, COULEURS_GROUPES[idx % COULEURS_GROUPES.length] ?? 'indigo');
  });

  const jourActuel = aujourdhui();
  // Groupe visé par les actions rapides : l'unique groupe de l'utilisateur, sinon celui du filtre. Avec plusieurs
  // groupes et le filtre « Tous », il n'y a pas de cible : les actions sont désactivées plutôt que de deviner.
  const groupesConnus = donnees?.groupes ?? moi.groupes;
  const groupeCible =
    groupesConnus.length === 1
      ? (groupesConnus[0] ?? null)
      : (groupesConnus.find((g) => g.group_id === filtreGroupe) ?? null);
  const idAideActions = 'aide-actions-groupe';
  const aideActions =
    groupesConnus.length === 0 ? t('tableau.groupes_vide') : t('tableau.choisir_groupe_aide');

  const actionCiblee = (suffixe: string, cle: CleTexte, icone: ReactNode, classe: string): ReactNode => {
    const libelle = t(cle);
    if (groupeCible === null) {
      return (
        <button type="button" className={classe} aria-disabled="true" aria-describedby={idAideActions}>
          {icone}
          <span>{libelle}</span>
        </button>
      );
    }
    const nomComplet = `${libelle} · ${groupeCible.name}`;
    return (
      <a href={`#/groupe/${encodeURIComponent(groupeCible.group_id)}/${suffixe}`} className={classe} title={nomComplet} aria-label={nomComplet}>
        {icone}
        <span>{libelle}</span>
      </a>
    );
  };

  const evenementsGroupesFiltres =
    donnees === null
      ? []
      : donnees.evenements.filter((e) => filtreGroupe === '' || e.group_id === filtreGroupe);

  const elementsCalendrier: ElementCalendrier[] =
    donnees === null
      ? []
      : [
          ...(filtreCalendrier === 'perso'
            ? []
            : evenementsGroupesFiltres.map((e) => ({
                sorte: 'groupe' as const,
                id: e.id,
                group_id: e.group_id,
                group_name: e.group_name,
                title: e.title,
                starts_at: e.starts_at,
                ends_at: e.ends_at,
                all_day: e.all_day,
                time_zone: e.time_zone,
                location_name: e.location_name,
                mon_statut: e.mon_statut,
              }))),
          ...(filtreCalendrier === 'groupes'
            ? []
            : donnees.evenements_perso.map((e) => ({
                sorte: 'perso' as const,
                id: e.id,
                title: e.title,
                starts_at: e.starts_at,
                ends_at: e.ends_at,
                all_day: e.all_day,
                time_zone: e.time_zone,
                location_name: e.location_name,
              }))),
        ].sort((a, b) => a.starts_at.localeCompare(b.starts_at));

  const parJour = new Map<string, ElementCalendrier[]>();
  for (const el of elementsCalendrier) {
    for (const jour of joursDe(el)) {
      parJour.set(jour, [...(parJour.get(jour) ?? []), el]);
    }
  }

  const semaine = joursDeSemaine(ancre);
  const nbEvenementsSemaine = semaine.reduce((acc, jour) => acc + (parJour.get(jour)?.length ?? 0), 0);
  const elementsListeAffiches =
    jourMobileSelectionne !== null ? (parJour.get(jourMobileSelectionne) ?? []) : elementsCalendrier;

  const evenementsAVenir = elementsCalendrier.filter((el) => jourDeDebut(el) >= jourActuel);
  const prochainEvenement = evenementsAVenir[0] ?? null;

  const soldesFiltres =
    donnees === null ? [] : donnees.soldes.filter((s) => filtreGroupe === '' || s.group_id === filtreGroupe);
  const soldesParDevise = new Map<string, number>();
  for (const s of soldesFiltres) {
    soldesParDevise.set(s.currency_code, (soldesParDevise.get(s.currency_code) ?? 0) + s.net_minor);
  }
  const devisesSoldes = Array.from(soldesParDevise.entries());
  const deviseUnique = devisesSoldes.length === 1 ? devisesSoldes[0] : null;
  const totalBalance = deviseUnique !== null && deviseUnique !== undefined ? deviseUnique[1] : 0;
  const classeBalance =
    devisesSoldes.length === 0
      ? 'kpi-neutre'
      : deviseUnique !== null && deviseUnique !== undefined
        ? totalBalance > 0
          ? 'kpi-positif'
          : totalBalance < 0
            ? 'kpi-negatif'
            : 'kpi-neutre'
        : 'kpi-neutre';
  const libelleBalance =
    devisesSoldes.length === 0
      ? formaterMontant(0, 'EUR')
      : deviseUnique !== null && deviseUnique !== undefined
        ? formaterMontant(deviseUnique[1], deviseUnique[0], true)
        : devisesSoldes.map(([dev, val]) => formaterMontant(val, dev, true)).join(' · ');
  const sousTitreBalance =
    devisesSoldes.length > 1
      ? t('tableau.kpi_multi_devises', { n: String(devisesSoldes.length) })
      : totalBalance > 0
        ? t('tableau.kpi_on_vous_doit')
        : totalBalance < 0
          ? t('tableau.kpi_a_equilibrer')
          : t('tableau.kpi_a_lequilibre');

  const groupesVisibles =
    donnees === null ? [] : donnees.groupes.filter((g) => filtreGroupe === '' || g.group_id === filtreGroupe);
  const nbGroupes = donnees?.groupes.length ?? moi.groupes.length;
  const moisCourant = jourActuel.slice(0, 7);
  const nbEvenementsMois = evenementsAVenir.filter((el) => jourDeDebut(el).slice(0, 7) === moisCourant).length;

  const photosFiltrees =
    donnees === null ? [] : donnees.photos.filter((p) => filtreGroupe === '' || p.group_id === filtreGroupe);
  const depensesFiltrees =
    donnees === null ? [] : donnees.depenses.filter((d) => filtreGroupe === '' || d.group_id === filtreGroupe);

  const precedent = (): void => setAncre(vueCalendrier === 'mois' ? moisVoisin(ancre, -1) : ajouterJours(ancre, -7));
  const suivant = (): void => setAncre(vueCalendrier === 'mois' ? moisVoisin(ancre, 1) : ajouterJours(ancre, 7));
  const libellePeriode =
    vueCalendrier === 'mois'
      ? libelleMois(ancre)
      : t('agenda.semaine_du', { jour: libelleJour(semaine[0] ?? ancre, { day: 'numeric', month: 'long' }) });

  const premierGroupePhotos = groupesVisibles.find((g) => g.photos_actives) ?? donnees?.groupes.find((g) => g.photos_actives);
  // Repli sur le premier groupe connu, et non sur `groupeCible` : c'est un lien de CONSULTATION,
  // il peut viser un groupe par défaut sans risque. Seules les actions de création exigent une
  // cible non ambiguë — sans ce repli, la tuile menait à la création de groupe.
  const premierGroupeDepenses =
    depensesFiltrees[0]?.group_id ??
    soldesFiltres[0]?.group_id ??
    groupeCible?.group_id ??
    groupesConnus[0]?.group_id ??
    '';

  // Sans événement à venir ni groupe ciblé, la tuile n'a nulle part où mener : elle n'est alors pas un lien.
  const hrefTuileProchain =
    prochainEvenement !== null
      ? lienElementCalendrier(prochainEvenement)
      : groupeCible !== null
        ? `#/groupe/${encodeURIComponent(groupeCible.group_id)}/evenement-nouveau`
        : null;
  const contenuTuileProchain = (
    <>
      <div className="kpi-texte">
        <span className="kpi-etiquette">{t('tableau.kpi_prochain_event')}</span>
        <strong className="kpi-valeur">
          {prochainEvenement !== null ? prochainEvenement.title : t('tableau.kpi_aucun_event')}
        </strong>
        <span className="kpi-sous kpi-indigo">
          {prochainEvenement !== null
            ? formaterDateRelative(prochainEvenement, jourActuel)
            : t('tableau.kpi_planifier')}
        </span>
      </div>
      <span className="kpi-icone-badge kpi-badge-indigo" aria-hidden="true">
        <IconeCalendrier className="kpi-icone" />
      </span>
    </>
  );

  return (
    <div className="tableau-de-bord">
      <section className="dashboard-entete">
        <div className="dashboard-entete-gauche">
          <h2>{t('tableau.vue_ensemble')}</h2>
          <p className="discret">{t('tableau.sous_titre_sync')}</p>
        </div>

        <div className="dashboard-entete-droite">
          <select
            className="filtre-groupe-local"
            aria-label={t('tableau.filtrer_groupe')}
            value={filtreGroupe}
            onChange={(e) => setFiltreGroupe(e.target.value)}
          >
            <option value="">{t('tableau.filtre_tous_groupes')}</option>
            {moi.groupes.map((g) => (
              <option key={g.group_id} value={g.group_id}>
                {g.name}
              </option>
            ))}
          </select>

          <div className="actions-rapides">
            {actionCiblee(
              'depenses',
              'tableau.action_depense',
              <IconePlus className="icone-action icone-emeraude" />,
              'bouton action-rapide',
            )}
            {actionCiblee(
              'listes',
              'tableau.action_liste',
              <IconeListe className="icone-action icone-ambre" />,
              'bouton action-rapide',
            )}
            {actionCiblee(
              'evenement-nouveau',
              'tableau.action_evenement',
              <IconeCalendrierPlus className="icone-action" />,
              'bouton bouton-primaire action-rapide',
            )}
            {onNouveauGroupe !== undefined ? (
              <button type="button" className="bouton action-rapide" onClick={onNouveauGroupe}>
                <IconePlus className="icone-action" />
                <span>{t('tableau.action_groupe')}</span>
              </button>
            ) : (
              <a href="#/nouveau" className="bouton action-rapide">
                <IconePlus className="icone-action" />
                <span>{t('tableau.action_groupe')}</span>
              </a>
            )}
          </div>
          {groupeCible === null && (
            <p id={idAideActions} className="discret">
              {aideActions}
            </p>
          )}
        </div>
      </section>

      <Erreur message={erreur} onReessayer={() => setTentative((n) => n + 1)} />
      {donnees === null && erreur === null && <p className="discret">{t('commun.chargement')}</p>}

      {donnees !== null && (
        <>
          <section className="barre-kpis" aria-label={t('tableau.vue_ensemble')}>
            {hrefTuileProchain !== null ? (
              <a href={hrefTuileProchain} className="carte kpi-tuile">
                {contenuTuileProchain}
              </a>
            ) : (
              <div className="carte kpi-tuile">{contenuTuileProchain}</div>
            )}

            <a
              href={
                premierGroupeDepenses !== ''
                  ? `#/groupe/${encodeURIComponent(premierGroupeDepenses)}/depenses`
                  : '#/nouveau'
              }
              className="carte kpi-tuile"
            >
              <div className="kpi-texte">
                <span className="kpi-etiquette">{t('tableau.kpi_balance')}</span>
                <strong className={`kpi-valeur ${classeBalance}`}>{libelleBalance}</strong>
                <span className="kpi-sous">{sousTitreBalance}</span>
              </div>
              <span className="kpi-icone-badge kpi-badge-emeraude" aria-hidden="true">
                <IconeBalance className="kpi-icone" />
              </span>
            </a>

            <a href={moi.invitations_en_attente > 0 ? '#/invitations' : '#/nouveau'} className="carte kpi-tuile">
              <div className="kpi-texte">
                <span className="kpi-etiquette">{t('tableau.kpi_groupes_actifs')}</span>
                <strong className="kpi-valeur">
                  {t(nbGroupes <= 1 ? 'tableau.kpi_n_groupes_singulier' : 'tableau.kpi_n_groupes_pluriel', {
                    n: String(nbGroupes),
                  })}
                </strong>
                <span className="kpi-sous kpi-ambre">
                  {moi.invitations_en_attente > 0
                    ? t('tableau.kpi_invitations_attente', { n: String(moi.invitations_en_attente) })
                    : t('tableau.kpi_evenements_mois', { n: String(nbEvenementsMois) })}
                </span>
              </div>
              <span className="kpi-icone-badge kpi-badge-ambre" aria-hidden="true">
                <IconeGroupes className="kpi-icone" />
              </span>
            </a>

            <a
              href={
                premierGroupePhotos !== undefined
                  ? `#/groupe/${encodeURIComponent(premierGroupePhotos.group_id)}/albums`
                  : '#/nouveau'
              }
              className="carte kpi-tuile"
            >
              <div className="kpi-texte">
                <span className="kpi-etiquette">{t('tableau.kpi_medias')}</span>
                <strong className="kpi-valeur">
                  {t(
                    photosFiltrees.length <= 1
                      ? 'tableau.kpi_n_photos_singulier'
                      : 'tableau.kpi_n_photos_pluriel',
                    { n: String(photosFiltrees.length) },
                  )}
                </strong>
                <span className="kpi-sous kpi-rose">
                  {photosFiltrees[0] !== undefined ? photosFiltrees[0].album_title : t('tableau.kpi_aucun_album')}
                </span>
              </div>
              <span className="kpi-icone-badge kpi-badge-rose" aria-hidden="true">
                <IconeCamera className="kpi-icone" />
              </span>
            </a>
          </section>

          <div className="grille-bento">
            <div className="bento-colonne-gauche">
              <section className="carte widget-agenda">
                <div className="carte-entete">
                  <div className="widget-titre-groupe">
                    <h3 className="widget-titre">
                      <IconeCalendrier className="widget-titre-icone icone-indigo" />
                      <span>{t('tableau.agenda_consolide')}</span>
                    </h3>
                    <span className="badge-mois">{badgeMoisCourt(ancre)}</span>
                  </div>

                  <div className="legende-sources">
                    {filtreCalendrier !== 'groupes' && (
                      <span className="legende-item">
                        <span className="pastille-couleur couleur-violet" aria-hidden="true" />
                        <span>{t('tableau.badge_perso')}</span>
                      </span>
                    )}
                    {filtreCalendrier !== 'perso' &&
                      groupesVisibles.slice(0, 4).map((g) => (
                        <span key={g.group_id} className="legende-item">
                          <span
                            className={`pastille-couleur couleur-${couleurParGroupe.get(g.group_id) ?? 'indigo'}`}
                            aria-hidden="true"
                          />
                          <span>{g.name}</span>
                        </span>
                      ))}
                  </div>
                </div>

                <div className="calendrier-barre-outils">
                  <div className="calendrier-controles">
                    <div className="barre-onglets" role="group" aria-label={t('tableau.calendrier_sources')}>
                      <button
                        type="button"
                        aria-pressed={filtreCalendrier === 'tous'}
                        onClick={() => setFiltreCalendrier('tous')}
                      >
                        {t('tableau.onglet_tous')}
                      </button>
                      <button
                        type="button"
                        aria-pressed={filtreCalendrier === 'groupes'}
                        onClick={() => setFiltreCalendrier('groupes')}
                      >
                        {t('tableau.onglet_groupes')}
                      </button>
                      <button
                        type="button"
                        aria-pressed={filtreCalendrier === 'perso'}
                        onClick={() => setFiltreCalendrier('perso')}
                      >
                        {t('tableau.onglet_perso')}
                      </button>
                    </div>
                    <div className="barre-onglets" role="group" aria-label={t('agenda.vues')}>
                      {VUES_CALENDRIER.map((v) => (
                        <button
                          key={v}
                          type="button"
                          aria-pressed={vueCalendrier === v}
                          onClick={() => {
                            setVueCalendrier(v);
                            if (v !== 'liste') setJourMobileSelectionne(null);
                          }}
                        >
                          {t(`agenda.vue_${v}` as const)}
                        </button>
                      ))}
                    </div>
                  </div>

                  {vueCalendrier !== 'liste' && (
                    <div className="calendrier-nav">
                      <div className="calendrier-nav-boutons">
                        <button type="button" onClick={precedent} aria-label={t('agenda.precedent')}>
                          {t('tableau.calendrier_precedent')}
                        </button>
                        <button type="button" onClick={() => setAncre(aujourdhui())}>
                          {t('agenda.aujourdhui')}
                        </button>
                        <button type="button" onClick={suivant} aria-label={t('agenda.suivant')}>
                          {t('tableau.calendrier_suivant')}
                        </button>
                      </div>
                      <strong className="calendrier-periode">{libellePeriode}</strong>
                    </div>
                  )}
                </div>

                <div className="ruban-hebdo-mobile">
                  <div className="ruban-hebdo-jours">
                    {semaine.map((jour) => {
                      const evenementsJour = parJour.get(jour) ?? [];
                      const estAujourdhui = jour === jourActuel;
                      const estSelectionne = jourMobileSelectionne === jour;
                      const premierEv = evenementsJour[0];
                      const couleurPoint =
                        premierEv === undefined
                          ? ''
                          : premierEv.sorte === 'perso'
                            ? 'couleur-violet'
                            : `couleur-${couleurParGroupe.get(premierEv.group_id) ?? 'indigo'}`;
                      return (
                        <button
                          key={jour}
                          type="button"
                          className={`ruban-jour${estAujourdhui ? ' aujourdhui' : ''}${estSelectionne ? ' selectionne' : ''}${evenementsJour.length > 0 ? ' avec-evenement' : ''}`}
                          aria-pressed={estSelectionne}
                          onClick={() => {
                            setJourMobileSelectionne(estSelectionne ? null : jour);
                            setVueCalendrier('liste');
                          }}
                        >
                          <span className="ruban-jour-nom">{libelleJourCourt(jour)}</span>
                          <span className="ruban-jour-num">{Number(jour.slice(8))}</span>
                          {evenementsJour.length > 0 && (
                            <span className={`ruban-jour-point ${couleurPoint}`} aria-hidden="true" />
                          )}
                        </button>
                      );
                    })}
                  </div>
                  <div className="ruban-hebdo-pied">
                    <span className="discret">
                      {nbEvenementsSemaine > 0
                        ? t('tableau.ruban_hebdo_compte', { n: String(nbEvenementsSemaine) })
                        : t('tableau.ruban_hebdo_aucun')}
                    </span>
                    <div className="ruban-hebdo-liens">
                      {jourMobileSelectionne !== null && (
                        <button type="button" className="lien" onClick={() => setJourMobileSelectionne(null)}>
                          {t('tableau.jour_filtre_effacer')}
                        </button>
                      )}
                      {vueCalendrier !== 'mois' && (
                        <button
                          type="button"
                          className="lien"
                          onClick={() => {
                            setJourMobileSelectionne(null);
                            setVueCalendrier('mois');
                          }}
                        >
                          {t('tableau.ouvrir_mois')}
                        </button>
                      )}
                    </div>
                  </div>
                </div>

                {vueCalendrier === 'liste' &&
                  (elementsListeAffiches.length === 0 ? (
                    <p className="discret">{t('tableau.calendrier_vide')}</p>
                  ) : (
                    <ul className="liste-elements">
                      {elementsListeAffiches.map((el) => {
                        const href = lienElementCalendrier(el);
                        return (
                          <li key={`${el.sorte}-${el.id}`}>
                            <a href={href} className="ligne-interactive">
                              <div className="ligne-principale">
                                <div className="ligne-badges">
                                  {el.sorte === 'groupe' ? (
                                    <span className="pilule pilule-agenda">{el.group_name}</span>
                                  ) : (
                                    <span className="pilule pilule-perso">{t('tableau.badge_perso')}</span>
                                  )}
                                  {el.sorte === 'groupe' && (
                                    <span className={`pilule pilule-statut-${el.mon_statut ?? 'aucun'}`}>
                                      {t(cleStatutCompact(el.mon_statut))}
                                    </span>
                                  )}
                                </div>
                                <strong className="ligne-titre">{el.title}</strong>
                                <span className="ligne-meta">
                                  {formaterDateEvenement(el.starts_at, el.all_day, el.time_zone)}
                                  {el.location_name !== null ? ` · ${el.location_name}` : ''}
                                </span>
                              </div>
                            </a>
                          </li>
                        );
                      })}
                    </ul>
                  ))}

                {vueCalendrier === 'mois' && (
                  <div className="grille-mois" role="table" aria-label={libellePeriode}>
                    <div className="grille-ligne" role="row">
                      {(grilleMois(ancre)[0] ?? []).map((jour) => (
                        <span key={jour} className="grille-entete" role="columnheader">
                          {libelleJourCourt(jour)}
                        </span>
                      ))}
                    </div>
                    {grilleMois(ancre).map((ligne) => (
                      <div key={ligne[0]} className="grille-ligne" role="row">
                        {ligne.map((jour) => (
                          <div
                            key={jour}
                            role="cell"
                            className={`grille-jour${jour.slice(0, 7) === ancre.slice(0, 7) ? '' : ' hors-mois'}${jour === jourActuel ? ' aujourdhui' : ''}`}
                          >
                            <span className="numero">{Number(jour.slice(8))}</span>
                            {(parJour.get(jour) ?? []).map((el) => {
                              const libelle = libellePastilleCalendrier(el);
                              const couleur =
                                el.sorte === 'perso' ? 'violet' : (couleurParGroupe.get(el.group_id) ?? 'indigo');
                              return (
                                <a
                                  key={`${el.sorte}-${el.id}`}
                                  href={lienElementCalendrier(el)}
                                  className={`evenement ${el.sorte === 'groupe' ? 'evenement-groupe' : 'evenement-perso'} bordure-${couleur}`}
                                  title={libelle}
                                >
                                  {libelle}
                                </a>
                              );
                            })}
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                )}

                {vueCalendrier === 'semaine' && (
                  <ul className="jours semaine">
                    {semaine.map((jour) => (
                      <li key={jour} className={jour === jourActuel ? 'aujourdhui' : undefined}>
                        <h3>{libelleJour(jour, { weekday: 'long', day: 'numeric', month: 'long' })}</h3>
                        {(parJour.get(jour) ?? []).length === 0 ? (
                          <p className="discret">{t('agenda.rien')}</p>
                        ) : (
                          (parJour.get(jour) ?? []).map((el) => (
                            <a
                              key={`${el.sorte}-${el.id}`}
                              href={lienElementCalendrier(el)}
                              className={`evenement ${el.sorte === 'groupe' ? 'evenement-groupe' : 'evenement-perso'}`}
                            >
                              <span className="evenement-heure">{libelleHoraire(el)}</span>{' '}
                              <span className="evenement-libelle">{libellePastilleCalendrier(el)}</span>
                            </a>
                          ))
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="carte widget-photos">
                <div className="carte-entete">
                  <h3 className="widget-titre">
                    <IconeCamera className="widget-titre-icone icone-rose" />
                    <span>{t('tableau.photos_titre')}</span>
                  </h3>
                  {premierGroupePhotos !== undefined && (
                    <a
                      href={`#/groupe/${encodeURIComponent(premierGroupePhotos.group_id)}/albums`}
                      className="lien-entete-widget"
                    >
                      {t('tableau.photos_galerie')}
                    </a>
                  )}
                </div>

                {photosFiltrees.length === 0 ? (
                  <div className="etat-vide-widget">
                    <p className="discret">{t('tableau.photos_vide')}</p>
                    <p className="discret">{t('tableau.photos_activer_immich')}</p>
                  </div>
                ) : (
                  <div className="grille-photos-bento">
                    {(photosFiltrees.length > 4 ? photosFiltrees.slice(0, 3) : photosFiltrees).map((p) => {
                      const legende = t('tableau.photo_legende', {
                        album: p.album_title,
                        groupe: p.group_name,
                      });
                      const couleur = couleurParGroupe.get(p.group_id) ?? 'indigo';
                      return (
                        <a
                          key={`${p.album_id}-${p.immich_asset_id}`}
                          href={`#/groupe/${encodeURIComponent(p.group_id)}/albums`}
                          className="vignette-photo-bento"
                          title={legende}
                        >
                          <img src={p.thumbnail_url} alt={legende} loading="lazy" />
                          <div className="vignette-overlay">
                            <span className={`vignette-badge badge-${couleur}`}>{p.group_name}</span>
                            <span className="vignette-album">{p.album_title}</span>
                          </div>
                        </a>
                      );
                    })}
                    {photosFiltrees.length > 4 && photosFiltrees[3] !== undefined && (
                      <a
                        href={`#/groupe/${encodeURIComponent(photosFiltrees[3].group_id)}/albums`}
                        className="vignette-photo-bento vignette-plus"
                      >
                        <img
                          src={photosFiltrees[3].thumbnail_url}
                          alt={t('tableau.voir_album')}
                          loading="lazy"
                        />
                        <div className="vignette-plus-voile">
                          <strong>{t('tableau.photos_plus', { n: String(photosFiltrees.length - 3) })}</strong>
                          <span>{t('tableau.voir_album')}</span>
                        </div>
                      </a>
                    )}
                  </div>
                )}
              </section>
            </div>

            <div className="bento-colonne-droite">
              <section className="carte widget-evenements">
                <div className="carte-entete">
                  <h3 className="widget-titre">
                    <IconeEtincelles className="widget-titre-icone icone-indigo" />
                    <span>{t('tableau.evenements_a_venir')}</span>
                  </h3>
                  <button
                    type="button"
                    className="lien-entete-widget bouton-lien"
                    onClick={() => {
                      setJourMobileSelectionne(null);
                      setVueCalendrier('liste');
                    }}
                  >
                    {t('tableau.tout_voir')}
                  </button>
                </div>

                {evenementsAVenir.length === 0 ? (
                  <p className="discret">{t('agenda.aucun')}</p>
                ) : (
                  <div className="liste-tuiles-evenements">
                    {evenementsAVenir.slice(0, 4).map((el) => {
                      const { mois, jour } = partiesVignetteDate(el);
                      const couleur = el.sorte === 'perso' ? 'violet' : (couleurParGroupe.get(el.group_id) ?? 'indigo');
                      const horaire = el.all_day ? t('tableau.journee_entiere') : libelleHoraire(el);
                      return (
                        <a key={`${el.sorte}-${el.id}`} href={lienElementCalendrier(el)} className="tuile-evenement">
                          <div className="tuile-evenement-haut">
                            <div className="tuile-evenement-gauche">
                              <div className={`vignette-date vignette-date-${couleur}`} aria-hidden="true">
                                <span className="vignette-date-mois">{mois}</span>
                                <span className="vignette-date-jour">{jour}</span>
                              </div>
                              <div className="tuile-evenement-info">
                                <strong className="tuile-evenement-titre">{el.title}</strong>
                                <span className="tuile-evenement-meta">
                                  <IconeLieu className="icone-mini" />
                                  <span>
                                    {el.location_name !== null ? `${el.location_name} · ${horaire}` : horaire}
                                  </span>
                                </span>
                              </div>
                            </div>
                            {el.sorte === 'groupe' ? (
                              <span className={`pilule pilule-statut-${el.mon_statut ?? 'aucun'}`}>
                                {t(cleStatutCompact(el.mon_statut))}
                              </span>
                            ) : (
                              <span className="pilule pilule-perso">{t('tableau.badge_perso')}</span>
                            )}
                          </div>
                          <div className="tuile-evenement-pied">
                            <span className={`tuile-evenement-source source-${couleur}`}>
                              {el.sorte === 'groupe' ? el.group_name : t('tableau.badge_perso')}
                            </span>
                          </div>
                        </a>
                      );
                    })}
                  </div>
                )}
              </section>

              <section className="carte widget-depenses">
                <div className="carte-entete">
                  <h3 className="widget-titre">
                    <IconeRecu className="widget-titre-icone icone-emeraude" />
                    <span>{t('tableau.depenses_recentes')}</span>
                  </h3>
                  {premierGroupeDepenses !== '' && (
                    <a
                      href={`#/groupe/${encodeURIComponent(premierGroupeDepenses)}/depenses`}
                      className="lien-entete-widget"
                    >
                      {t('tableau.equilibrer')}
                    </a>
                  )}
                </div>

                {soldesFiltres.length > 0 && (
                  <div className="soldes-pilules">
                    {soldesFiltres.map((s) => {
                      const classe =
                        s.net_minor > 0 ? 'pilule-positif' : s.net_minor < 0 ? 'pilule-negatif' : 'pilule-neutre';
                      return (
                        <a
                          key={`${s.group_id}-${s.currency_code}`}
                          href={`#/groupe/${encodeURIComponent(s.group_id)}/depenses`}
                          className={`pilule-solde ${classe}`}
                        >
                          <span className="pilule-solde-groupe">{s.group_name}</span>
                          <strong>{formaterMontant(s.net_minor, s.currency_code, true)}</strong>
                        </a>
                      );
                    })}
                  </div>
                )}

                {depensesFiltrees.length === 0 ? (
                  <p className="discret">{t('tableau.depenses_vide')}</p>
                ) : (
                  <ul className="liste-elements">
                    {depensesFiltrees.slice(0, 4).map((d) => (
                      <li key={d.id}>
                        <a
                          href={`#/groupe/${encodeURIComponent(d.group_id)}/depenses`}
                          className="ligne-interactive ligne-depense"
                        >
                          <span className="depense-icone-rond" aria-hidden="true">
                            <IconeRecu className="icone-mini" />
                          </span>
                          <div className="ligne-principale">
                            <strong className="ligne-titre">{d.label}</strong>
                            <span className="ligne-meta">
                              {t('tableau.depense_paye_par', {
                                nom: d.payer_name,
                                groupe: d.group_name,
                                date: formaterDateCourte(d.spent_on),
                              })}
                            </span>
                          </div>
                          <span className="montant-depense">{formaterMontant(d.amount_minor, d.currency_code)}</span>
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="carte widget-groupes">
                <div className="carte-entete">
                  <h3 className="widget-titre">
                    <IconeGroupes className="widget-titre-icone icone-ambre" />
                    <span>{t('tableau.groupes_titre')}</span>
                  </h3>
                </div>
                {groupesVisibles.length === 0 ? (
                  <p className="discret">{t('tableau.groupes_vide')}</p>
                ) : (
                  <div className="liste-groupes-compacte">
                    {groupesVisibles.map((g) => {
                      const base = `#/groupe/${encodeURIComponent(g.group_id)}`;
                      return (
                        <article key={g.group_id} className="tuile-groupe">
                          <div className="tuile-groupe-haut">
                            <a href={base} className="tuile-groupe-nom">
                              {g.name}
                            </a>
                            <span className={`pilule pilule-role-${g.role}`}>
                              {t(g.role === 'admin' ? 'tableau.role_admin' : 'tableau.role_member')}
                            </span>
                          </div>
                          <div className="tuile-groupe-liens">
                            <a href={`${base}/agenda`} className="pilule-lien pilule-lien-agenda">
                              {t('tableau.raccourci_agenda')}
                            </a>
                            <a href={`${base}/listes`} className="pilule-lien">
                              {t('tableau.raccourci_listes')}
                            </a>
                            <a href={`${base}/depenses`} className="pilule-lien pilule-lien-depenses">
                              {t('tableau.raccourci_depenses')}
                            </a>
                            {g.photos_actives && (
                              <a href={`${base}/albums`} className="pilule-lien pilule-lien-photos">
                                {t('tableau.raccourci_photos')}
                              </a>
                            )}
                          </div>
                        </article>
                      );
                    })}
                  </div>
                )}
              </section>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
