import { useEffect, useState } from 'react';
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

function formaterMontant(montantMineur: number, devise: string, avecSigne = false): string {
  const exposant = devise === 'JPY' ? 0 : 2;
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

function formaterDateEvenement(iso: string, touteLaJournee: boolean): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  if (touteLaJournee) {
    const jour = new Intl.DateTimeFormat('fr-FR', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    }).format(date);
    return `${jour} · ${t('tableau.journee_entiere')}`;
  }
  return new Intl.DateTimeFormat('fr-FR', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function formaterDateCourte(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat('fr-FR', {
    day: 'numeric',
    month: 'short',
  }).format(date);
}

function formaterDateRelative(el: ElementCalendrier, jourAujourdHui: string): string {
  const jour = jourDeDebut(el);
  const horaire = el.all_day ? t('tableau.journee_entiere') : libelleHoraire(el);
  if (jour === jourAujourdHui) return `${t('tableau.aujourdhui')} · ${horaire}`;
  if (jour === ajouterJours(jourAujourdHui, 1)) return `${t('tableau.demain')} · ${horaire}`;
  return formaterDateEvenement(el.starts_at, el.all_day);
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
  const [fenetreChargee, setFenetreChargee] = useState<'defaut' | { readonly du: string; readonly au: string } | null>(null);

  useEffect(() => {
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
  }, [vueCalendrier, ancre, fenetreChargee]);

  const couleurParGroupe = new Map<string, CouleurGroupe>();
  (donnees?.groupes ?? moi.groupes).forEach((g, idx) => {
    couleurParGroupe.set(g.group_id, COULEURS_GROUPES[idx % COULEURS_GROUPES.length] ?? 'indigo');
  });

  const jourActuel = aujourdhui();
  const groupeCibleAction = filtreGroupe !== '' ? filtreGroupe : (donnees?.groupes[0]?.group_id ?? moi.groupes[0]?.group_id ?? '');
  const hrefActionDepense =
    groupeCibleAction !== '' ? `#/groupe/${encodeURIComponent(groupeCibleAction)}/depenses` : '#/nouveau';
  const hrefActionListe =
    groupeCibleAction !== '' ? `#/groupe/${encodeURIComponent(groupeCibleAction)}/listes` : '#/nouveau';
  const hrefActionEvenement =
    filtreGroupe !== '' ? `#/groupe/${encodeURIComponent(filtreGroupe)}/evenement-nouveau` : '#/compte';

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
  const premierGroupeDepenses = depensesFiltrees[0]?.group_id ?? soldesFiltres[0]?.group_id ?? groupeCibleAction;

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
            <a href={hrefActionDepense} className="bouton action-rapide">
              <IconePlus className="icone-action icone-emeraude" />
              <span>{t('tableau.action_depense')}</span>
            </a>
            <a href={hrefActionListe} className="bouton action-rapide">
              <IconeListe className="icone-action icone-ambre" />
              <span>{t('tableau.action_liste')}</span>
            </a>
            <a href={hrefActionEvenement} className="bouton bouton-primaire action-rapide">
              <IconeCalendrierPlus className="icone-action" />
              <span>{t('tableau.action_evenement')}</span>
            </a>
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
        </div>
      </section>

      <Erreur message={erreur} />
      {donnees === null && erreur === null && <p className="discret">{t('commun.chargement')}</p>}

      {donnees !== null && (
        <>
          <section className="barre-kpis" aria-label={t('tableau.vue_ensemble')}>
            <a
              href={prochainEvenement !== null ? lienElementCalendrier(prochainEvenement) : '#/compte'}
              className="carte kpi-tuile"
            >
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
            </a>

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
                                  {formaterDateEvenement(el.starts_at, el.all_day)}
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
