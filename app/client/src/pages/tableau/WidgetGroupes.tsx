import type { GroupeTableauDeBord } from '../../api/tableau-de-bord';
import { IconeGroupes } from '../../components/Icones';
import { t } from '../../i18n';

export function WidgetGroupes({ groupes }: { groupes: readonly GroupeTableauDeBord[] }) {
  return (
    <section className="carte widget-groupes">
      <div className="carte-entete">
        <h3 className="widget-titre">
          <IconeGroupes className="widget-titre-icone icone-ambre" />
          <span>{t('tableau.groupes_titre')}</span>
        </h3>
      </div>
      {groupes.length === 0 ? (
        <p className="discret">{t('tableau.groupes_vide')}</p>
      ) : (
        <div className="liste-groupes-compacte">
          {groupes.map((g) => {
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
  );
}
