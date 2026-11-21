import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import { t, type CleTexte } from '../i18n';
import { etatActionsCreation, type ActionCreation } from '../lib/actions-creation';
import { premierVisible } from '../lib/retour-focus';
import { IconeCalendrierPlus, IconeGroupes, IconeListe, IconeRecu } from './Icones';

const LIBELLES: Readonly<Record<ActionCreation, CleTexte>> = {
  evenement: 'creation.evenement',
  depense: 'creation.depense',
  liste: 'creation.liste',
};

const ICONES: Readonly<Record<ActionCreation, ReactNode>> = {
  evenement: <IconeCalendrierPlus className="feuille-creation-icone" />,
  depense: <IconeRecu className="feuille-creation-icone" />,
  liste: <IconeListe className="feuille-creation-icone" />,
};

/**
 * Feuille de choix du bouton « Créer » (bandeau du bas sur téléphone, barre latérale sur grand écran) : un panneau qui monte du bas, avec les quatre créations.
 * Bâtie sur `<dialog>` + `showModal()` comme `DialogueConfirmation` : piège à focus, Échap et `aria-modal` sont natifs.
 * Le focus arrive sur le premier élément actif et revient au déclencheur à la fermeture (voir `boutonsOuvrants`). Le clic sur le fond ferme.
 *
 * Trois des quatre créations exigent un groupe : la cible est celle de `groupeCible` (via `etatActionsCreation`, même règle que
 * les raccourcis du tableau de bord). Un seul groupe : il est visé d'office. Plusieurs : la feuille laisse choisir, préselectionné
 * sur le groupe de la page courante. Aucun : seule « Nouveau groupe » est active, les autres disent pourquoi.
 */
export function FeuilleCreation({
  ouvert,
  groupes,
  groupeInitial,
  boutonsOuvrants,
  onFermer,
}: {
  ouvert: boolean;
  groupes: ReadonlyArray<{ readonly group_id: string; readonly name: string }>;
  /** Groupe de la page courante (`''` hors d'un groupe) : présélection quand le compte en a plusieurs. */
  groupeInitial: string;
  /**
   * Déclencheurs de la feuille, celui qui l'a ouverte EN PREMIER : le focus revient au premier encore visible (Safari ne
   * focalise pas un bouton au clic, `activeElement` serait faux ; et un redimensionnement peut masquer le déclencheur d'origine).
   */
  boutonsOuvrants: ReadonlyArray<RefObject<HTMLElement | null>>;
  onFermer: () => void;
}) {
  const dialogue = useRef<HTMLDialogElement>(null);
  const idTitre = useId();
  const idAide = useId();
  const [choix, setChoix] = useState(groupeInitial);

  useEffect(() => {
    const el = dialogue.current;
    if (el === null) return;
    if (ouvert && !el.open) {
      setChoix(groupes.some((g) => g.group_id === groupeInitial) ? groupeInitial : '');
      el.showModal();
      el.querySelector<HTMLElement>('select, a[href], button:not([aria-disabled="true"])')?.focus();
    } else if (!ouvert && el.open) {
      el.close();
      const cible = premierVisible(
        boutonsOuvrants.flatMap((r) => (r.current === null ? [] : [r.current])),
        (b) => b.getClientRects().length > 0,
      );
      // Aucun déclencheur visible : le contenu principal, plutôt qu'un focus perdu sur `<body>`.
      (cible ?? document.getElementById('contenu-principal'))?.focus();
    }
  }, [ouvert, groupes, groupeInitial, boutonsOuvrants]);

  // Démontée alors qu'elle est ouverte (navigation) : on referme proprement.
  useEffect(() => {
    const el = dialogue.current;
    return () => {
      if (el?.open === true) el.close();
    };
  }, []);

  const etats = etatActionsCreation(groupes, choix);
  // Ordre d'affichage : événement, groupe, dépense, liste.
  const [evenement, depense, liste] = etats;
  const ordre = [evenement, 'groupe' as const, depense, liste].filter((e) => e !== undefined);
  const raison = etats[0]?.raison ?? null;
  const aide = raison === 'aucun_groupe' ? t('creation.aucun_groupe') : raison === 'choisir_groupe' ? t('creation.choisir_groupe') : null;

  return (
    <dialog
      ref={dialogue}
      className="feuille-creation"
      aria-modal="true"
      aria-labelledby={idTitre}
      onCancel={(e) => {
        e.preventDefault();
        onFermer();
      }}
      onClose={() => {
        // Filet de sécurité : un navigateur peut fermer le dialogue sans `cancel` ; le parent garde sinon `ouvert` à vrai.
        if (ouvert) onFermer();
      }}
      onClick={(e) => {
        // Le fond (`::backdrop`) est la cible du clic sur le dialogue lui-même ; le contenu est dans `.feuille-creation-corps`.
        if (e.target === e.currentTarget) onFermer();
      }}
    >
      <div className="feuille-creation-corps">
        <h2 id={idTitre}>{t('creation.titre')}</h2>
        {groupes.length > 1 && (
          <label className="feuille-creation-groupe">
            <span>{t('creation.groupe_pour')}</span>
            <select value={choix} onChange={(e) => setChoix(e.target.value)}>
              <option value="">{t('creation.choisir_option')}</option>
              {groupes.map((g) => (
                <option key={g.group_id} value={g.group_id}>
                  {g.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <ul className="feuille-creation-liste">
          {ordre.map((e) =>
            e === 'groupe' ? (
              <li key="groupe">
                <a href="#/nouveau" className="feuille-creation-entree" onClick={onFermer}>
                  <IconeGroupes className="feuille-creation-icone" />
                  <span>{t('creation.groupe')}</span>
                </a>
              </li>
            ) : (
              <li key={e.action}>
                {e.lien !== null && e.groupe !== null ? (
                  <a
                    href={e.lien}
                    className="feuille-creation-entree"
                    aria-label={t('creation.entree_groupe', { libelle: t(LIBELLES[e.action]), groupe: e.groupe.name })}
                    onClick={onFermer}
                  >
                    {ICONES[e.action]}
                    <span>{t(LIBELLES[e.action])}</span>
                  </a>
                ) : (
                  <button type="button" className="feuille-creation-entree" aria-disabled="true" aria-describedby={idAide}>
                    {ICONES[e.action]}
                    <span>{t(LIBELLES[e.action])}</span>
                  </button>
                )}
              </li>
            ),
          )}
        </ul>
        {aide !== null && (
          <p id={idAide} className="discret">
            {aide}
          </p>
        )}
        <button type="button" className="feuille-creation-fermer" onClick={onFermer}>
          <span>{t('creation.fermer')}</span>
        </button>
      </div>
    </dialog>
  );
}
