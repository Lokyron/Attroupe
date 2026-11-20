import type { PhotoTableauDeBord } from '../../api/tableau-de-bord';
import { IconeCamera } from '../../components/Icones';
import { t } from '../../i18n';
import type { CouleurGroupe } from './selecteurs';

export function WidgetPhotos({
  photos,
  groupePhotosId,
  couleurParGroupe,
}: {
  photos: readonly PhotoTableauDeBord[];
  groupePhotosId: string | null;
  couleurParGroupe: ReadonlyMap<string, CouleurGroupe>;
}) {
  const reste = photos[3];
  return (
    <section className="carte widget-photos">
      <div className="carte-entete">
        <h3 className="widget-titre">
          <IconeCamera className="widget-titre-icone icone-rose" />
          <span>{t('tableau.photos_titre')}</span>
        </h3>
        {groupePhotosId !== null && (
          <a href={`#/groupe/${encodeURIComponent(groupePhotosId)}/albums`} className="lien-entete-widget">
            {t('tableau.photos_galerie')}
          </a>
        )}
      </div>

      {photos.length === 0 ? (
        <div className="etat-vide-widget">
          <p className="discret">{t('tableau.photos_vide')}</p>
          <p className="discret">{t('tableau.photos_activer_immich')}</p>
        </div>
      ) : (
        <div className="grille-photos-bento">
          {(photos.length > 4 ? photos.slice(0, 3) : photos).map((p) => {
            const legende = t('tableau.photo_legende', { album: p.album_title, groupe: p.group_name });
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
          {photos.length > 4 && reste !== undefined && (
            <a
              href={`#/groupe/${encodeURIComponent(reste.group_id)}/albums`}
              className="vignette-photo-bento vignette-plus"
            >
              <img src={reste.thumbnail_url} alt={t('tableau.voir_album')} loading="lazy" />
              <div className="vignette-plus-voile">
                <strong>{t('tableau.photos_plus', { n: String(photos.length - 3) })}</strong>
                <span>{t('tableau.voir_album')}</span>
              </div>
            </a>
          )}
        </div>
      )}
    </section>
  );
}
