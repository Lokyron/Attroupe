import { useEffect, useId, useRef } from 'react';
import { t } from '../i18n';

/**
 * Confirmation modale d'une action destructrice ou irréversible, en remplacement de `window.confirm`.
 *
 * Bâtie sur `<dialog>` + `showModal()` : piège à focus, fermeture par Échap et `aria-modal` sont natifs.
 * Le focus arrive sur « Annuler » (jamais sur le bouton destructeur) et revient à l'élément ouvrant à la fermeture.
 * Le parent reste maître de `ouvert` : Échap et « Annuler » appellent `onAnnuler`, qui doit le repasser à `false`.
 *
 * Les libellés viennent des vues : `libelleConfirmer` = verbe + objet (« Supprimer la dépense »), jamais « OK » ;
 * `libelleAnnuler` lève l'ambiguïté quand l'action s'appelle elle-même « annuler » (« Garder l'événement »).
 */
export function DialogueConfirmation({
  ouvert,
  titre,
  consequence,
  reversible,
  libelleConfirmer,
  libelleAnnuler,
  danger,
  onConfirmer,
  onAnnuler,
}: {
  ouvert: boolean;
  titre: string;
  consequence: string;
  reversible: boolean;
  libelleConfirmer: string;
  libelleAnnuler?: string;
  danger: boolean;
  onConfirmer: () => void;
  onAnnuler: () => void;
}) {
  const dialogue = useRef<HTMLDialogElement>(null);
  const boutonAnnuler = useRef<HTMLButtonElement>(null);
  const ouvrant = useRef<Element | null>(null);
  const idTitre = useId();
  const idConsequence = useId();

  useEffect(() => {
    const el = dialogue.current;
    if (el === null) return;
    if (ouvert && !el.open) {
      ouvrant.current = document.activeElement;
      el.showModal();
      boutonAnnuler.current?.focus();
    } else if (!ouvert && el.open) {
      el.close();
      if (ouvrant.current instanceof HTMLElement) ouvrant.current.focus();
      ouvrant.current = null;
    }
  }, [ouvert]);

  // Si le dialogue est démonté alors qu'il est ouvert (navigation), on le referme proprement.
  useEffect(() => {
    const el = dialogue.current;
    return () => {
      if (el?.open === true) el.close();
    };
  }, []);

  return (
    <dialog
      ref={dialogue}
      className="dialogue-confirmation"
      aria-labelledby={idTitre}
      aria-describedby={idConsequence}
      onCancel={(e) => {
        // Échap : on laisse le parent décider ; la fermeture passe par `ouvert`.
        e.preventDefault();
        onAnnuler();
      }}
      onClose={() => {
        // Filet de sécurité : certains navigateurs ferment un dialogue sans émettre `cancel` (règle
        // anti-abus de Chrome sur Échap répété). Sans cette ligne, le parent garderait `ouvert` à
        // vrai alors que le dialogue est fermé, et il ne se rouvrirait plus jamais.
        if (ouvert) onAnnuler();
      }}
    >
      <h2 id={idTitre}>{titre}</h2>
      <p id={idConsequence}>
        {consequence}
        {!reversible && <strong className="dialogue-definitif"> {t('commun.definitif')}</strong>}
      </p>
      <div className="dialogue-actions">
        <button type="button" ref={boutonAnnuler} onClick={onAnnuler}>
          {libelleAnnuler ?? t('commun.annuler')}
        </button>
        <button type="button" className={danger ? 'bouton-danger' : 'bouton-primaire'} onClick={onConfirmer}>
          {libelleConfirmer}
        </button>
      </div>
    </dialog>
  );
}
