import { useRef, useState, type FormEvent } from 'react';
import {
  cloturerEvenement,
  confirmerRemboursement,
  creerDepense,
  creerRemboursement,
  lireSoldes,
  listerDepenses,
  listerDevises,
  listerRemboursements,
  reouvrirEvenement,
  supprimerDepense,
  supprimerRemboursement,
  type Depense,
  type Devise,
  type ModeRepartition,
  type Remboursement,
  type ResultatSoldes,
} from '../api/depenses';
import { listerMembres, type Membre } from '../api/groupes';
import { ChargementPage, SqueletteListe } from '../components/ChargementPage';
import { DialogueConfirmation } from '../components/DialogueConfirmation';
import { EnteteGroupe } from '../components/EnteteGroupe';
import { Erreur, messageDe } from '../components/Erreur';
import { useGroupe } from '../components/FournisseurGroupe';
import { IconeBalance, IconePoubelle, IconeRecu } from '../components/Icones';
import { fusionnerEtats, premiereErreur } from '../hooks/etatsLecture';
import { useLecture } from '../hooks/useLecture';
import { useSoumission } from '../hooks/useSoumission';
import { t } from '../i18n';
import { formaterMontantExposant } from '../lib/montants';

function formaterMontant(minor: number, code: string, devises: readonly Devise[]): string {
  return formaterMontantExposant(minor, code, devises.find((d) => d.code === code)?.exponent ?? 2);
}

/**
 * Lit un montant saisi en unités majeures et le rend en unités mineures, ou `null` s'il est invalide.
 * Seul le bruit de saisie est toléré avant l'analyse : espaces (ordinaires, insécables U+00A0, fines
 * insécables U+202F) et symbole de devise. Le nombre lui-même reste strict (décimales limitées à l'exposant).
 */
function analyserMontant(saisie: string, exposant: number, autoriserZero = false): number | null {
  const texte = saisie.replace(/[\s\u00A0\u202F]/g, '').replace(/\p{Sc}/gu, '');
  if (texte === '') return null;
  if (exposant === 0) {
    if (!/^\d+$/.test(texte)) return null;
    const v = BigInt(texte);
    if ((!autoriserZero && v <= 0n) || v > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return Number(v);
  }
  const m = texte.match(/^(\d+)(?:[,.](\d+))?$/);
  if (!m) return null;
  const entiere = m[1] ?? '';
  const decimale = m[2] ?? '';
  if (decimale.length > exposant) return null;
  const v = BigInt(entiere) * 10n ** BigInt(exposant) + BigInt(decimale.padEnd(exposant, '0'));
  if ((!autoriserZero && v <= 0n) || v > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(v);
}

/**
 * Date du jour dans le fuseau local, au format AAAA-MM-JJ. `toISOString()` serait piégeux ici : il convertit
 * en UTC, donc entre minuit et 1 h ou 2 h à Paris il rend encore la date de la veille.
 */
function aujourdhuiIso(): string {
  const maintenant = new Date();
  const mois = String(maintenant.getMonth() + 1).padStart(2, '0');
  const jour = String(maintenant.getDate()).padStart(2, '0');
  return `${String(maintenant.getFullYear())}-${mois}-${jour}`;
}

/** Date AAAA-MM-JJ (sans heure) lisible, lue en UTC pour ne jamais glisser d'un jour selon le fuseau. */
function formaterDateJour(jour: string): string {
  const date = new Date(`${jour}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return jour;
  return new Intl.DateTimeFormat('fr-FR', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

function formaterMoisAnnee(moisIso: string): string {
  const date = new Date(`${moisIso}-01T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return moisIso;
  return new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(date);
}

function formaterSaisieMontant(minor: number, code: string, devises: readonly Devise[]): string {
  const exposant = devises.find((d) => d.code === code)?.exponent ?? 2;
  if (exposant === 0) return String(minor);
  const facteur = 10 ** exposant;
  const entier = Math.floor(minor / facteur);
  const dec = String(minor % facteur).padStart(exposant, '0');
  return `${String(entier)},${dec}`;
}

/** Action en attente de confirmation dans le dialogue unique de la section. */
type Confirmation =
  | { readonly type: 'supprimer'; readonly depense: Depense }
  | { readonly type: 'cloturer' }
  | { readonly type: 'rouvrir' }
  | {
      readonly type: 'recu';
      readonly remboursement: Remboursement;
      readonly montant: string;
      readonly nom: string;
    }
  | {
      readonly type: 'annuler_remb';
      readonly remboursement: Remboursement;
      readonly montant: string;
    };

export interface PropsSectionDepenses {
  readonly groupId: string;
  readonly evenementId?: string;
  readonly peutCloturer?: boolean;
  readonly deviseCibleDefaut?: string;
  readonly membresFournis?: readonly Membre[];
}

/**
 * Bloc complet des dépenses, soldes, règlements et (si rattaché à un événement) clôture.
 * Utilisé à la fois par la page `#/groupe/:id/depenses` et dans le détail d'un événement.
 */
export function SectionDepenses({
  groupId,
  evenementId,
  peutCloturer = false,
  deviseCibleDefaut,
  membresFournis,
}: PropsSectionDepenses) {
  // Erreur des actions (écritures, rechargement partiel) ; celle de la lecture initiale est gérée par `ChargementPage`.
  const [erreur, setErreur] = useState<string | null>(null);

  // Le groupe vient du contexte, lu EN PARALLÈLE de cette lecture (les états sont fusionnés plus bas : un seul squelette).
  const { groupe, etat: etatGroupe, erreur: erreurGroupe, rechargerGroupe } = useGroupe();

  // Lecture initiale : membres et devises ne bougent pas ensuite, seules les trois dernières valeurs sont rafraîchies.
  // Si `membresFournis` est fourni, il fait foi (voir `membres` plus bas) : la lecture n'a pas à le suivre.
  const {
    donnees,
    etat: etatLecture,
    erreur: erreurLecture,
    recharger,
  } = useLecture(
    () =>
      Promise.all([
        membresFournis !== undefined ? Promise.resolve([...membresFournis]) : listerMembres(groupId),
        listerDevises(),
        listerDepenses(groupId, evenementId),
        listerRemboursements(groupId, evenementId),
        lireSoldes(groupId, evenementId),
      ]).then(([membres, devises, depenses, remboursements, soldes]) => ({
        membres,
        devises,
        depenses,
        remboursements,
        soldes,
      })),
    [groupId, evenementId],
  );

  // Rechargement partiel après une écriture. Le résultat est rattaché à la lecture initiale (`base`) dont il
  // prolonge les données : si celle-ci est relancée entre-temps, il devient obsolète et n'est plus utilisé.
  const [partiel, setPartiel] = useState<{
    base: unknown;
    depenses: Depense[];
    remboursements: Remboursement[];
    soldes: ResultatSoldes;
  } | null>(null);
  // Garde de validité : seul le dernier rechargement partiel lancé peut s'appliquer.
  const generationPartielle = useRef(0);

  const [formDepenseOuvert, setFormDepenseOuvert] = useState(false);
  const [formRembOuvert, setFormRembOuvert] = useState(false);
  const [erreursChamps, setErreursChamps] = useState<Record<string, string>>({});
  const [erreurFormDepense, setErreurFormDepense] = useState<string | null>(null);
  const [erreurFormRemb, setErreurFormRemb] = useState<string | null>(null);
  const [limiteDepenses, setLimiteDepenses] = useState(20);
  const [limiteRemboursements, setLimiteRemboursements] = useState(15);
  const refFormDepense = useRef<HTMLDivElement>(null);
  const refFormRemb = useRef<HTMLDivElement>(null);

  // Formulaire de nouvelle dépense
  const [libelle, setLibelle] = useState('');
  const [dateDepense, setDateDepense] = useState(aujourdhuiIso);
  const [montantSaisi, setMontantSaisi] = useState('');
  // `null` tant que l'utilisateur n'a rien choisi : la devise effective suit alors celle du groupe.
  const [deviseChoisie, setDeviseChoisie] = useState<string | null>(null);
  const [tauxSaisi, setTauxSaisi] = useState('1');
  const [payeurId, setPayeurId] = useState('');
  const [mode, setMode] = useState<ModeRepartition>('equal');
  const [participantsCoches, setParticipantsCoches] = useState<Record<string, boolean>>({});
  const [poidsParMembre, setPoidsParMembre] = useState<Record<string, string>>({});
  const [partsExactesParMembre, setPartsExactesParMembre] = useState<Record<string, string>>({});

  // Formulaire de règlement
  const [deMembreId, setDeMembreId] = useState('');
  const [versMembreId, setVersMembreId] = useState('');
  const [montantRembSaisi, setMontantRembSaisi] = useState('');
  const [deviseRembChoisie, setDeviseRembChoisie] = useState<string | null>(null);
  const [tauxRembSaisi, setTauxRembSaisi] = useState('1');
  const [noteRemb, setNoteRemb] = useState('');

  // Une instance de garde par action indépendante : cliquer « Clôturer » ne doit pas désactiver le formulaire d'ajout.
  const soumDepense = useSoumission();
  const soumRemb = useSoumission();
  const soumCloture = useSoumission();
  const soumSuppression = useSoumission();
  const soumRecu = useSoumission();

  // Un seul dialogue, monté en permanence, piloté par l'action en attente de confirmation.
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);

  /** Rafraîchit ce qui bouge après une écriture (dépenses, remboursements, soldes), sans relire groupe/membres/devises. */
  const rechargerPartiel = (): Promise<void> => {
    generationPartielle.current += 1;
    const numero = generationPartielle.current;
    const base = donnees;
    return Promise.all([
      listerDepenses(groupId, evenementId),
      listerRemboursements(groupId, evenementId),
      lireSoldes(groupId, evenementId),
    ]).then(([deps, rembs, slds]) => {
      if (numero !== generationPartielle.current) return;
      setPartiel({ base, depenses: deps, remboursements: rembs, soldes: slds });
    });
  };

  // Sans lecture terminée, `ChargementPage` n'affiche pas le contenu : on ne rend rien d'autre ici.
  const devises = donnees?.devises ?? [];
  const membres: readonly Membre[] = membresFournis ?? donnees?.membres ?? [];
  const actuel = partiel !== null && partiel.base === donnees ? partiel : null;
  const depenses = actuel?.depenses ?? donnees?.depenses ?? [];
  const remboursements = actuel?.remboursements ?? donnees?.remboursements ?? [];
  const soldes = actuel?.soldes ?? donnees?.soldes ?? null;

  const actifs = membres.filter((m) => m.status === 'active');
  // Valeurs par défaut dérivées plutôt qu'écrites au chargement : un membre arrivé plus tard est coché d'office.
  const monId = groupe?.mon_appartenance_id ?? '';
  const payeurEffectif = payeurId !== '' ? payeurId : monId;
  const deMembreEffectif = deMembreId !== '' ? deMembreId : monId;
  const versMembreEffectif = versMembreId !== '' ? versMembreId : (actifs.find((a) => a.id !== monId)?.id ?? '');
  const estCoche = (id: string): boolean => participantsCoches[id] !== false;

  const deviseCible = deviseCibleDefaut ?? groupe?.default_currency_code ?? '';
  const deviseCode = deviseChoisie ?? deviseCible;
  const deviseRembCode = deviseRembChoisie ?? deviseCible;
  const estCloture = soldes !== null && soldes.cloture !== null;
  const nomDe = (id: string): string => membres.find((m) => m.id === id)?.display_name ?? t('groupe.ancien_membre');

  const soumettreDepense = (e: FormEvent): void => {
    e.preventDefault();
    setErreur(null);
    setErreurFormDepense(null);
    const errs: Record<string, string> = {};
    if (libelle.trim() === '') errs['libelle'] = t('depenses.erreur_libelle');

    const exposant = devises.find((d) => d.code === deviseCode)?.exponent ?? 2;
    const minor = analyserMontant(montantSaisi, exposant);
    if (minor === null) errs['montant'] = t('depenses.erreur_montant');

    let ratePpm: number | undefined;
    if (deviseCode !== deviseCible) {
      const ppm = analyserMontant(tauxSaisi, 6);
      if (ppm === null) errs['taux'] = t('depenses.erreur_taux');
      else ratePpm = ppm;
    }

    const selectionnes = actifs.filter((m) => estCoche(m.id));
    if (selectionnes.length === 0) errs['participants'] = t('depenses.erreur_participants');

    const shares: Array<Parameters<typeof creerDepense>[1]['shares'][number]> = [];
    for (const m of selectionnes) {
      if (mode === 'weights') {
        const w = Number(poidsParMembre[m.id] ?? '1');
        if (!Number.isInteger(w) || w <= 0) {
          errs['parts'] = t('erreur.depenses.poids_invalide');
          break;
        }
        shares.push({ membership_id: m.id, weight: w });
      } else if (mode === 'exact') {
        const part = analyserMontant(partsExactesParMembre[m.id] ?? '0', exposant, true);
        if (part === null) {
          errs['parts'] = t('depenses.erreur_parts_exactes');
          break;
        }
        shares.push({ membership_id: m.id, share_minor: part });
      } else {
        shares.push({ membership_id: m.id });
      }
    }

    if (Object.keys(errs).length > 0 || minor === null) {
      setErreursChamps(errs);
      refFormDepense.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      return;
    }
    setErreursChamps({});

    soumDepense
      .lancer(() =>
        creerDepense(groupId, {
          event_id: evenementId ?? null,
          label: libelle.trim(),
          spent_on: dateDepense,
          payer_membership_id: payeurEffectif,
          amount_minor: minor,
          currency_code: deviseCode,
          ...(ratePpm !== undefined ? { rate_ppm: ratePpm } : {}),
          split_mode: mode,
          shares,
        }).then(() => {
          setLibelle('');
          setMontantSaisi('');
          setErreursChamps({});
          setFormDepenseOuvert(false);
          return rechargerPartiel();
        }),
      )
      .catch((err: unknown) => {
        setErreurFormDepense(messageDe(err));
        refFormDepense.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
  };

  const soumettreRemboursement = (e: FormEvent): void => {
    e.preventDefault();
    setErreur(null);
    setErreurFormRemb(null);
    const errs: Record<string, string> = {};
    if (deMembreEffectif === '' || versMembreEffectif === '' || deMembreEffectif === versMembreEffectif) {
      errs['remb_membres'] = t('depenses.erreur_membres_identiques');
    }
    const exposant = devises.find((d) => d.code === deviseRembCode)?.exponent ?? 2;
    const minor = analyserMontant(montantRembSaisi, exposant);
    if (minor === null) {
      errs['remb_montant'] = t('depenses.erreur_montant');
    }

    let ratePpm: number | undefined;
    if (deviseRembCode !== deviseCible) {
      const ppm = analyserMontant(tauxRembSaisi, 6);
      if (ppm === null) errs['remb_taux'] = t('depenses.erreur_taux');
      else ratePpm = ppm;
    }

    if (Object.keys(errs).length > 0 || minor === null) {
      setErreursChamps(errs);
      refFormRemb.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      return;
    }
    setErreursChamps({});

    soumRemb
      .lancer(() =>
        creerRemboursement(groupId, {
          event_id: evenementId ?? null,
          from_membership_id: deMembreEffectif,
          to_membership_id: versMembreEffectif,
          amount_minor: minor,
          currency_code: deviseRembCode,
          ...(ratePpm !== undefined ? { rate_ppm: ratePpm } : {}),
          settled_on: aujourdhuiIso(),
          method_note: noteRemb.trim() === '' ? null : noteRemb.trim(),
        }).then(() => {
          setMontantRembSaisi('');
          setNoteRemb('');
          setErreursChamps({});
          setFormRembOuvert(false);
          return rechargerPartiel();
        }),
      )
      .catch((err: unknown) => {
        setErreurFormRemb(messageDe(err));
        refFormRemb.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
  };

  /** Exécute l'action confirmée. Le dialogue est refermé d'abord : il est contrôlé et ne se ferme jamais seul. */
  const confirmerAction = (): void => {
    if (confirmation === null) return;
    const action = confirmation;
    setConfirmation(null);
    setErreur(null);
    switch (action.type) {
      case 'supprimer':
        soumSuppression
          .lancer(() => supprimerDepense(groupId, action.depense.id).then(rechargerPartiel))
          .catch((err: unknown) => setErreur(messageDe(err)));
        return;
      case 'cloturer':
        if (evenementId === undefined) return;
        soumCloture
          .lancer(() => cloturerEvenement(groupId, evenementId).then(rechargerPartiel))
          .catch((err: unknown) => setErreur(messageDe(err)));
        return;
      case 'rouvrir':
        if (evenementId === undefined) return;
        soumCloture
          .lancer(() => reouvrirEvenement(groupId, evenementId).then(rechargerPartiel))
          .catch((err: unknown) => setErreur(messageDe(err)));
        return;
      case 'recu':
        soumRecu
          .lancer(() => confirmerRemboursement(groupId, action.remboursement.id).then(rechargerPartiel))
          .catch((err: unknown) => setErreur(messageDe(err)));
        return;
      case 'annuler_remb':
        soumSuppression
          .lancer(() => supprimerRemboursement(groupId, action.remboursement.id).then(rechargerPartiel))
          .catch((err: unknown) => setErreur(messageDe(err)));
        return;
    }
  };

  // Textes du dialogue : sûrs quand `confirmation` est `null` (le dialogue reste monté).
  const textesConfirmation = ((): {
    titre: string;
    consequence: string;
    action: string;
    reversible: boolean;
    danger: boolean;
  } => {
    switch (confirmation?.type) {
      case 'supprimer':
        return {
          titre: t('confirm.depenses.supprimer.titre', {
            libelle: confirmation.depense.label,
          }),
          consequence: t('confirm.depenses.supprimer.consequence'),
          action: t('confirm.depenses.supprimer.action'),
          reversible: false,
          danger: true,
        };
      case 'cloturer':
        return {
          titre: t('confirm.depenses.cloturer.titre'),
          consequence: t('confirm.depenses.cloturer.consequence'),
          action: t('confirm.depenses.cloturer.action'),
          reversible: true,
          danger: false,
        };
      case 'rouvrir':
        return {
          titre: t('confirm.depenses.rouvrir.titre'),
          consequence: t('confirm.depenses.rouvrir.consequence'),
          action: t('confirm.depenses.rouvrir.action'),
          reversible: true,
          danger: false,
        };
      case 'recu':
        return {
          titre: t('confirm.depenses.confirmer_recu.titre', {
            montant: confirmation.montant,
            nom: confirmation.nom,
          }),
          consequence: t('confirm.depenses.confirmer_recu.consequence'),
          action: t('confirm.depenses.confirmer_recu.action'),
          reversible: false,
          danger: false,
        };
      case 'annuler_remb':
        return {
          titre: t('confirm.depenses.annuler_remb.titre', {
            montant: confirmation.montant,
          }),
          consequence: t('confirm.depenses.annuler_remb.consequence'),
          action: t('confirm.depenses.annuler_remb.action'),
          reversible: false,
          danger: true,
        };
      case undefined:
        return {
          titre: '',
          consequence: '',
          action: '',
          reversible: true,
          danger: false,
        };
    }
  })();

  return (
    <ChargementPage
      etat={fusionnerEtats(etatGroupe, etatLecture)}
      erreur={premiereErreur(erreurGroupe, erreurLecture)}
      onReessayer={() => {
        if (etatGroupe === 'erreur') rechargerGroupe();
        recharger();
      }}
      squelette={<SqueletteListe lignes={4} />}
    >
      {donnees !== null && groupe !== null && soldes !== null && (
        <div className="page-groupe-pile">
          <Erreur message={erreur} />

          {evenementId !== undefined && (estCloture || peutCloturer) && (
            <div className="carte barre">
              {estCloture ? (
                <>
                  <span role="status" className="pilule pilule-statut-maybe">
                    {t('depenses.cloture_active')}
                  </span>
                  {peutCloturer && (
                    <button
                      type="button"
                      className="bouton-compact"
                      disabled={soumCloture.enCours}
                      onClick={() => setConfirmation({ type: 'rouvrir' })}
                    >
                      {soumCloture.enCours ? t('commun.enregistrement') : t('depenses.reouvrir')}
                    </button>
                  )}
                </>
              ) : (
                peutCloturer && (
                  <button
                    type="button"
                    className="bouton-compact"
                    disabled={soumCloture.enCours}
                    onClick={() => setConfirmation({ type: 'cloturer' })}
                  >
                    {soumCloture.enCours ? t('commun.enregistrement') : t('depenses.cloturer')}
                  </button>
                )
              )}
            </div>
          )}

          <div className="carte">
            <div className="carte-entete">
              <h3 className="widget-titre">
                <IconeBalance className="widget-titre-icone icone-emeraude" />
                <span>{t('depenses.soldes_titre')}</span>
              </h3>
              {!estCloture && (
                <div className="barre-compacte">
                  <button
                    type="button"
                    className={formDepenseOuvert ? 'bouton-compact' : 'bouton-primaire bouton-compact'}
                    onClick={() => {
                      setFormDepenseOuvert(!formDepenseOuvert);
                      if (!formDepenseOuvert) setFormRembOuvert(false);
                    }}
                  >
                    {t(formDepenseOuvert ? 'depenses.fermer_formulaire' : 'depenses.ajouter_bouton')}
                  </button>
                  {actifs.length >= 2 && (
                    <button
                      type="button"
                      className="bouton-compact"
                      onClick={() => {
                        setFormRembOuvert(!formRembOuvert);
                        if (!formRembOuvert) setFormDepenseOuvert(false);
                      }}
                    >
                      {t(formRembOuvert ? 'depenses.fermer_formulaire' : 'depenses.declarer_bouton')}
                    </button>
                  )}
                </div>
              )}
            </div>

            {soldes.ardoises.length === 0 ? (
              <p className="discret">{t('depenses.aucun_solde')}</p>
            ) : (
              <div className="grille-soldes-ardoises">
                {soldes.ardoises.map((ardoise) => (
                  <div key={ardoise.currency_code} className="grille-soldes-resume">
                    <div className="bloc-resume-soldes">
                      <h4 className="sous-titre-compact">{ardoise.currency_code}</h4>
                      <div className="soldes-pilules">
                        {ardoise.soldes.map((s) => {
                          const classe =
                            s.net_minor > 0 ? 'pilule-positif' : s.net_minor < 0 ? 'pilule-negatif' : 'pilule-neutre';
                          return (
                            <span key={s.membership_id} className={`pilule-solde ${classe}`}>
                              <span>{nomDe(s.membership_id)}</span>
                              <strong>{formaterMontant(s.net_minor, ardoise.currency_code, devises)}</strong>
                            </span>
                          );
                        })}
                      </div>
                    </div>
                    {ardoise.transferts.length > 0 && (
                      <div className="bloc-resume-suggestions">
                        <h4 className="sous-titre-compact">{t('depenses.suggestions_titre')}</h4>
                        <ul className="liste-elements">
                          {ardoise.transferts.map((tr, idx) => (
                            <li
                              key={`${tr.from_membership_id}-${tr.to_membership_id}-${String(idx)}`}
                              className="ligne ligne-compacte"
                            >
                              <span>
                                {t('depenses.suggestion_ligne', {
                                  de: nomDe(tr.from_membership_id),
                                  vers: nomDe(tr.to_membership_id),
                                  montant: formaterMontant(tr.amount_minor, tr.currency_code, devises),
                                })}
                              </span>
                              {!estCloture && actifs.length >= 2 && (
                                <button
                                  type="button"
                                  className="bouton-compact"
                                  onClick={() => {
                                    setDeMembreId(tr.from_membership_id);
                                    setVersMembreId(tr.to_membership_id);
                                    setMontantRembSaisi(formaterSaisieMontant(tr.amount_minor, tr.currency_code, devises));
                                    setDeviseRembChoisie(tr.currency_code);
                                    setErreursChamps({});
                                    setErreurFormRemb(null);
                                    setFormRembOuvert(true);
                                    setFormDepenseOuvert(false);
                                    setTimeout(() => refFormRemb.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 0);
                                  }}
                                >
                                  {t('depenses.preremplir_reglement')}
                                </button>
                              )}
                            </li>
                          ))}
                        </ul>
                        <p className="texte-doux">{t('depenses.aucun_flux_bancaire')}</p>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {!estCloture && formDepenseOuvert && (
            <div ref={refFormDepense} className="carte">
              <div className="carte-entete">
                <h3>{t('depenses.ajouter_titre')}</h3>
              </div>
              <Erreur message={erreurFormDepense} />
              <form onSubmit={soumettreDepense} className="formulaire" noValidate>
                <label>
                  {t('depenses.champ_libelle')}
                  <input
                    type="text"
                    value={libelle}
                    maxLength={140}
                    aria-invalid={erreursChamps['libelle'] !== undefined}
                    aria-describedby={erreursChamps['libelle'] !== undefined ? 'err-depense-libelle' : undefined}
                    onChange={(e) => {
                      setLibelle(e.target.value);
                      if (erreursChamps['libelle'] !== undefined) {
                        // La clé est SUPPRIMÉE, pas vidée : `aria-invalid` se lit sur `!== undefined`.
                        setErreursChamps(({ libelle: _corrige, ...autres }) => autres);
                      }
                    }}
                    required
                  />
                  {erreursChamps['libelle'] !== undefined && (
                    <p id="err-depense-libelle" className="erreur-champ" role="alert">
                      {erreursChamps['libelle']}
                    </p>
                  )}
                </label>
                <div className="grille-champs-2">
                  <label>
                    {t('depenses.champ_montant')}
                    <input
                      type="text"
                      inputMode="decimal"
                      autoComplete="off"
                      value={montantSaisi}
                      onChange={(e) => setMontantSaisi(e.target.value)}
                      placeholder={t('depenses.exemple_montant')}
                      aria-invalid={erreursChamps['montant'] !== undefined}
                      aria-describedby={
                        erreursChamps['montant'] !== undefined
                          ? 'err-depense-montant aide-montant-depense'
                          : 'aide-montant-depense'
                      }
                      required
                    />
                    {erreursChamps['montant'] !== undefined && (
                      <p id="err-depense-montant" className="erreur-champ" role="alert">
                        {erreursChamps['montant']}
                      </p>
                    )}
                    {/* La contrainte est dite avant l'erreur : le `placeholder` seul ne suffit pas,
                    il disparaît dès la première frappe. */}
                    <small id="aide-montant-depense" className="texte-doux">
                      {t('depenses.aide_montant')}
                    </small>
                  </label>
                  <label>
                    {t('depenses.champ_devise')}
                    <select value={deviseCode} onChange={(e) => setDeviseChoisie(e.target.value)}>
                      {devises.map((d) => (
                        <option key={d.code} value={d.code}>
                          {t('depenses.option_devise', {
                            code: d.code,
                            symbole: d.symbol,
                          })}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                {deviseCode !== deviseCible && (
                  <label>
                    {t('depenses.champ_taux', {
                      source: deviseCode,
                      cible: deviseCible,
                    })}
                    <input
                      type="text"
                      inputMode="decimal"
                      autoComplete="off"
                      value={tauxSaisi}
                      onChange={(e) => setTauxSaisi(e.target.value)}
                      placeholder={t('depenses.exemple_montant')}
                      aria-invalid={erreursChamps['taux'] !== undefined}
                      aria-describedby={erreursChamps['taux'] !== undefined ? 'err-depense-taux' : undefined}
                      required
                    />
                    {erreursChamps['taux'] !== undefined && (
                      <p id="err-depense-taux" className="erreur-champ" role="alert">
                        {erreursChamps['taux']}
                      </p>
                    )}
                  </label>
                )}
                <div className="grille-champs-2">
                  <label>
                    {t('depenses.champ_date')}
                    <input type="date" value={dateDepense} onChange={(e) => setDateDepense(e.target.value)} required />
                  </label>
                  <label>
                    {t('depenses.champ_payeur')}
                    <select value={payeurEffectif} onChange={(e) => setPayeurId(e.target.value)}>
                      {actifs.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.display_name}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <label>
                  {t('depenses.champ_mode')}
                  <select value={mode} onChange={(e) => setMode(e.target.value as ModeRepartition)}>
                    <option value="equal">{t('depenses.mode_equal')}</option>
                    <option value="weights">{t('depenses.mode_weights')}</option>
                    <option value="exact">{t('depenses.mode_exact')}</option>
                  </select>
                </label>
                <fieldset className="champ-participants">
                  <legend>{t('depenses.champ_participants')}</legend>
                  {actifs.map((m) => (
                    <div key={m.id} className="barre">
                      <label className="ligne-case">
                        <input
                          type="checkbox"
                          checked={estCoche(m.id)}
                          onChange={(e) =>
                            setParticipantsCoches((p) => ({
                              ...p,
                              [m.id]: e.target.checked,
                            }))
                          }
                        />
                        {m.display_name}
                      </label>
                      {estCoche(m.id) && mode === 'weights' && (
                        <input
                          type="number"
                          min={1}
                          value={poidsParMembre[m.id] ?? '1'}
                          onChange={(e) =>
                            setPoidsParMembre((p) => ({
                              ...p,
                              [m.id]: e.target.value,
                            }))
                          }
                        />
                      )}
                      {estCoche(m.id) && mode === 'exact' && (
                        <input
                          type="text"
                          inputMode="decimal"
                          autoComplete="off"
                          aria-label={`${t('depenses.champ_mode')} ${m.display_name}`}
                          placeholder={t('depenses.exemple_part')}
                          value={partsExactesParMembre[m.id] ?? ''}
                          onChange={(e) =>
                            setPartsExactesParMembre((p) => ({
                              ...p,
                              [m.id]: e.target.value,
                            }))
                          }
                        />
                      )}
                    </div>
                  ))}
                  {erreursChamps['participants'] !== undefined && (
                    <p className="erreur-champ" role="alert">
                      {erreursChamps['participants']}
                    </p>
                  )}
                  {erreursChamps['parts'] !== undefined && (
                    <p className="erreur-champ" role="alert">
                      {erreursChamps['parts']}
                    </p>
                  )}
                </fieldset>
                <button type="submit" disabled={soumDepense.enCours}>
                  {soumDepense.enCours ? t('commun.enregistrement') : t('depenses.ajouter')}
                </button>
              </form>
            </div>
          )}

          {!estCloture && formRembOuvert && actifs.length >= 2 && (
            <div ref={refFormRemb} className="carte">
              <div className="carte-entete">
                <h3>{t('depenses.declarer_remboursement')}</h3>
              </div>
              <p className="texte-doux">{t('depenses.aucun_flux_bancaire')}</p>
              <Erreur message={erreurFormRemb} />
              <form onSubmit={soumettreRemboursement} className="formulaire" noValidate>
                <div className="grille-champs-2">
                  <label>
                    {t('depenses.champ_de')}
                    <select
                      value={deMembreEffectif}
                      aria-invalid={erreursChamps['remb_membres'] !== undefined}
                      onChange={(e) => setDeMembreId(e.target.value)}
                    >
                      {actifs.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.display_name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    {t('depenses.champ_vers')}
                    <select
                      value={versMembreEffectif}
                      aria-invalid={erreursChamps['remb_membres'] !== undefined}
                      onChange={(e) => setVersMembreId(e.target.value)}
                    >
                      {actifs.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.display_name}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                {erreursChamps['remb_membres'] !== undefined && (
                  <p className="erreur-champ" role="alert">
                    {erreursChamps['remb_membres']}
                  </p>
                )}
                <div className="grille-champs-2">
                  <label>
                    {t('depenses.champ_montant')}
                    <input
                      type="text"
                      inputMode="decimal"
                      autoComplete="off"
                      value={montantRembSaisi}
                      onChange={(e) => setMontantRembSaisi(e.target.value)}
                      placeholder={t('depenses.exemple_montant')}
                      aria-invalid={erreursChamps['remb_montant'] !== undefined}
                      aria-describedby={erreursChamps['remb_montant'] !== undefined ? 'err-remb-montant' : undefined}
                      required
                    />
                    {erreursChamps['remb_montant'] !== undefined && (
                      <p id="err-remb-montant" className="erreur-champ" role="alert">
                        {erreursChamps['remb_montant']}
                      </p>
                    )}
                  </label>
                  <label>
                    {t('depenses.champ_devise')}
                    <select value={deviseRembCode} onChange={(e) => setDeviseRembChoisie(e.target.value)}>
                      {devises.map((d) => (
                        <option key={d.code} value={d.code}>
                          {t('depenses.option_devise', {
                            code: d.code,
                            symbole: d.symbol,
                          })}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                {deviseRembCode !== deviseCible && (
                  <label>
                    {t('depenses.champ_taux', {
                      source: deviseRembCode,
                      cible: deviseCible,
                    })}
                    <input
                      type="text"
                      inputMode="decimal"
                      autoComplete="off"
                      value={tauxRembSaisi}
                      onChange={(e) => setTauxRembSaisi(e.target.value)}
                      placeholder={t('depenses.exemple_montant')}
                      aria-invalid={erreursChamps['remb_taux'] !== undefined}
                      aria-describedby={erreursChamps['remb_taux'] !== undefined ? 'err-remb-taux' : undefined}
                      required
                    />
                    {erreursChamps['remb_taux'] !== undefined && (
                      <p id="err-remb-taux" className="erreur-champ" role="alert">
                        {erreursChamps['remb_taux']}
                      </p>
                    )}
                  </label>
                )}
                <label>
                  {t('depenses.champ_note_hors_app')}
                  <input type="text" maxLength={200} value={noteRemb} onChange={(e) => setNoteRemb(e.target.value)} />
                </label>
                <button type="submit" disabled={soumRemb.enCours}>
                  {soumRemb.enCours ? t('commun.enregistrement') : t('depenses.enregistrer_remboursement')}
                </button>
              </form>
            </div>
          )}

          <div className="carte">
            <div className="carte-entete">
              <h3 className="widget-titre">
                <IconeRecu className="widget-titre-icone icone-rose" />
                <span>{t('depenses.liste_titre')}</span>
              </h3>
            </div>
            {depenses.length === 0 ? (
              <div className="etat-vide">
                <p>{t('depenses.aucune')}</p>
                {!estCloture && (
                  <button
                    type="button"
                    className="bouton-primaire bouton-compact"
                    onClick={() => {
                      setFormDepenseOuvert(true);
                      setFormRembOuvert(false);
                    }}
                  >
                    {t('depenses.ajouter_bouton')}
                  </button>
                )}
              </div>
            ) : (
              <>
                {(() => {
                  const tranche = depenses.slice(0, limiteDepenses);
                  const groupesMois: Array<{ readonly mois: string; readonly items: Depense[] }> = [];
                  for (const d of tranche) {
                    const mois = d.spent_on.slice(0, 7);
                    const dernier = groupesMois[groupesMois.length - 1];
                    if (dernier !== undefined && dernier.mois === mois) {
                      dernier.items.push(d);
                    } else {
                      groupesMois.push({ mois, items: [d] });
                    }
                  }
                  return groupesMois.map((gm) => (
                    <div key={gm.mois} className="groupe-mois-depenses">
                      <h4 className="sous-titre-compact">{formaterMoisAnnee(gm.mois)}</h4>
                      <ul className="liste-elements">
                        {gm.items.map((d) => {
                          const peutSupprimer =
                            !estCloture &&
                            (d.created_by_membership_id === groupe.mon_appartenance_id ||
                              d.payer_membership_id === groupe.mon_appartenance_id ||
                              groupe.mon_role === 'admin');
                          return (
                            <li key={d.id} className="ligne ligne-depense">
                              <span className="depense-icone-rond" aria-hidden="true">
                                <IconeRecu className="icone-mini" />
                              </span>
                              <div className="ligne-principale">
                                <span className="ligne-titre">{d.label}</span>
                                <span className="ligne-meta">
                                  {t('depenses.paye_par', { nom: nomDe(d.payer_membership_id) })}
                                  {t('commun.separateur_point')}
                                  <time dateTime={d.spent_on}>{formaterDateJour(d.spent_on)}</time>
                                </span>
                              </div>
                              <div className="ligne-depense-droite">
                                <div className="montant-depense-pile">
                                  <span className="montant-depense">
                                    {formaterMontant(d.amount_minor, d.currency_code, devises)}
                                  </span>
                                  {d.currency_code !== d.target_currency_code && (
                                    <span className="ligne-meta">
                                      {t('depenses.converti_info', {
                                        montant_cible: formaterMontant(d.amount_target_minor, d.target_currency_code, devises),
                                      })}
                                    </span>
                                  )}
                                </div>
                                {peutSupprimer && (
                                  <button
                                    type="button"
                                    className="bouton-icone-discret"
                                    aria-label={`${t('depenses.supprimer')} ${d.label}`}
                                    disabled={soumSuppression.enCours}
                                    onClick={() => setConfirmation({ type: 'supprimer', depense: d })}
                                  >
                                    <IconePoubelle className="icone-mini" />
                                  </button>
                                )}
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  ));
                })()}
                {depenses.length > limiteDepenses && (
                  <p className="barre-compacte">
                    <button
                      type="button"
                      className="bouton-compact"
                      onClick={() => setLimiteDepenses((n) => n + 20)}
                    >
                      {t('depenses.voir_plus', { reste: String(depenses.length - limiteDepenses) })}
                    </button>
                  </p>
                )}
              </>
            )}
          </div>

          {(remboursements.length > 0 || (!estCloture && actifs.length >= 2)) && (
            <div className="carte">
              <div className="carte-entete">
                <h3>{t('depenses.reglements_titre')}</h3>
              </div>
              {remboursements.length === 0 ? (
                <div className="etat-vide">
                  <p>{t('depenses.aucun_remboursement')}</p>
                  <button
                    type="button"
                    className="bouton-compact"
                    onClick={() => {
                      setFormRembOuvert(true);
                      setFormDepenseOuvert(false);
                    }}
                  >
                    {t('depenses.declarer_bouton')}
                  </button>
                </div>
              ) : (
                <>
                  <ul className="liste-elements">
                    {remboursements.slice(0, limiteRemboursements).map((r) => {
                      const confirme = r.confirmed_by_membership_id !== null;
                      const statut = t(confirme ? 'depenses.statut_confirme' : 'depenses.statut_en_attente');
                      const montant = formaterMontant(r.amount_minor, r.currency_code, devises);
                      const peutAnnuler =
                        !estCloture &&
                        !confirme &&
                        (r.recorded_by_membership_id === groupe.mon_appartenance_id || groupe.mon_role === 'admin');
                      return (
                        <li key={r.id} className="ligne">
                          <div className="ligne-principale">
                            <span className="ligne-titre">
                              {r.method_note !== null
                                ? t('depenses.remboursement_ligne_note', {
                                    de: nomDe(r.from_membership_id),
                                    vers: nomDe(r.to_membership_id),
                                    montant,
                                    statut,
                                    note: r.method_note,
                                  })
                                : t('depenses.remboursement_ligne', {
                                    de: nomDe(r.from_membership_id),
                                    vers: nomDe(r.to_membership_id),
                                    montant,
                                    statut,
                                  })}
                            </span>
                          </div>
                          <div className="ligne-actions-discretes">
                            <span className={`pilule${confirme ? ' pilule-statut-yes' : ' pilule-statut-maybe'}`}>
                              {statut}
                            </span>
                            {!estCloture && !confirme && r.to_membership_id === groupe.mon_appartenance_id && (
                              <button
                                type="button"
                                className="bouton-compact"
                                aria-label={`${t('depenses.confirmer')} ${nomDe(r.from_membership_id)} → ${nomDe(r.to_membership_id)}`}
                                disabled={soumRecu.enCours}
                                onClick={() =>
                                  setConfirmation({
                                    type: 'recu',
                                    remboursement: r,
                                    montant,
                                    nom: nomDe(r.from_membership_id),
                                  })
                                }
                              >
                                {soumRecu.enCours ? t('commun.enregistrement') : t('depenses.confirmer')}
                              </button>
                            )}
                            {peutAnnuler && (
                              <button
                                type="button"
                                className="bouton-compact"
                                aria-label={`${t('depenses.annuler_remboursement')} ${nomDe(r.from_membership_id)} → ${nomDe(r.to_membership_id)}`}
                                disabled={soumSuppression.enCours}
                                onClick={() =>
                                  setConfirmation({
                                    type: 'annuler_remb',
                                    remboursement: r,
                                    montant,
                                  })
                                }
                              >
                                {t('depenses.annuler_remboursement')}
                              </button>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                  {remboursements.length > limiteRemboursements && (
                    <p className="barre-compacte">
                      <button
                        type="button"
                        className="bouton-compact"
                        onClick={() => setLimiteRemboursements((n) => n + 15)}
                      >
                        {t('depenses.voir_plus', { reste: String(remboursements.length - limiteRemboursements) })}
                      </button>
                    </p>
                  )}
                </>
              )}
            </div>
          )}

          <DialogueConfirmation
            ouvert={confirmation !== null}
            titre={textesConfirmation.titre}
            consequence={textesConfirmation.consequence}
            reversible={textesConfirmation.reversible}
            libelleConfirmer={textesConfirmation.action}
            danger={textesConfirmation.danger}
            onConfirmer={confirmerAction}
            onAnnuler={() => setConfirmation(null)}
          />
        </div>
      )}
    </ChargementPage>
  );
}

/** Page `#/groupe/:id/depenses` : dépenses, soldes et règlements du groupe. */
export function Depenses({ groupId }: { groupId: string }) {
  return (
    <section className="page-groupe-pile">
      <EnteteGroupe ongletActif="depenses" titre={t('depenses.titre')} />
      <SectionDepenses groupId={groupId} />
    </section>
  );
}
