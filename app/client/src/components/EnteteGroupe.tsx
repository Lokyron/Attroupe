import type { ReactNode } from 'react';
import { t } from '../i18n';
import { useGroupe } from './FournisseurGroupe';
import {
  IconeCalendrier,
  IconeCamera,
  IconeGroupes,
  IconeListe,
  IconeMessage,
  IconeRecu,
  IconeRetour,
  IconeSondage,
} from './Icones';

export type OngletGroupe = 'apercu' | 'agenda' | 'listes' | 'sondages' | 'depenses' | 'fils' | 'photos';

export interface PropsEnteteGroupe {
  readonly ongletActif: OngletGroupe;
  readonly titre?: string | undefined;
  readonly meta?: ReactNode | undefined;
  readonly actions?: ReactNode | undefined;
  readonly lienRetour?: { readonly href: string; readonly libelle: string } | undefined;
}

/** En-tête compact partagé par toutes les pages internes d'un groupe + barre d'onglets défilable. */
export function EnteteGroupe({ ongletActif, titre, meta, actions, lienRetour }: PropsEnteteGroupe) {
  const { groupId, groupe, nom } = useGroupe();
  const base = `#/groupe/${encodeURIComponent(groupId)}`;
  // `nom` vient de `moi.groupes` dès le premier rendu : plus de « Groupe » puis saut vers le vrai nom.
  const nomAffiche = nom !== '' ? nom : t('nav.groupe');
  const titreAffiche = titre ?? nomAffiche;
  // Inconnu avant la lecture : l'onglet n'est pas affiché plutôt qu'affiché à faux.
  const afficherPhotos = groupe?.fonctionnalites.photos ?? false;

  const onglets: Array<{
    readonly id: OngletGroupe;
    readonly href: string;
    readonly libelle: string;
    readonly icone: ReactNode;
    readonly visible?: boolean;
  }> = [
    { id: 'apercu', href: base, libelle: t('groupe_nav.apercu'), icone: <IconeGroupes className="icone-mini" /> },
    { id: 'agenda', href: `${base}/agenda`, libelle: t('groupe_nav.agenda'), icone: <IconeCalendrier className="icone-mini" /> },
    { id: 'listes', href: `${base}/listes`, libelle: t('groupe_nav.listes'), icone: <IconeListe className="icone-mini" /> },
    { id: 'sondages', href: `${base}/sondages`, libelle: t('groupe_nav.sondages'), icone: <IconeSondage className="icone-mini" /> },
    { id: 'depenses', href: `${base}/depenses`, libelle: t('groupe_nav.depenses'), icone: <IconeRecu className="icone-mini" /> },
    { id: 'fils', href: `${base}/fils`, libelle: t('groupe_nav.fils'), icone: <IconeMessage className="icone-mini" /> },
    {
      id: 'photos',
      href: `${base}/albums`,
      libelle: t('groupe_nav.photos'),
      icone: <IconeCamera className="icone-mini" />,
      visible: afficherPhotos,
    },
  ];

  return (
    <header className="carte groupe-entete-boite">
      <div className="groupe-entete">
        <div className="groupe-entete-gauche">
          {lienRetour !== undefined && (
            <a href={lienRetour.href} className="groupe-retour-lien">
              <IconeRetour className="icone-mini" />
              <span>{lienRetour.libelle}</span>
            </a>
          )}
          <div className="groupe-entete-titres">
            <h2>{titreAffiche}</h2>
            {titre !== undefined && titre !== nomAffiche && <span className="discret groupe-nom-parent">{nomAffiche}</span>}
          </div>
          {meta !== undefined && <div className="groupe-meta">{meta}</div>}
        </div>
        {actions !== undefined && <div className="groupe-entete-actions">{actions}</div>}
      </div>
      <nav className="onglets-groupe" aria-label={nomAffiche}>
        {onglets
          .filter((o) => o.visible !== false)
          .map((o) => {
            const actif = o.id === ongletActif;
            return (
              <a
                key={o.id}
                href={o.href}
                className={`onglet-groupe${actif ? ' actif' : ''}`}
                aria-current={actif ? 'page' : undefined}
              >
                {o.icone}
                <span>{o.libelle}</span>
              </a>
            );
          })}
      </nav>
    </header>
  );
}
