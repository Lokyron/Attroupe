import type { PhotoTableauDeBord } from '../../api/tableau-de-bord';
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
    <div className="widget-photos">
      {groupePhotosId !== null && (
        <a href={`#/groupe/${encodeURIComponent(groupePhotosId)}/albums`} className="lien-entete-widget">
          {t('tableau.photos_galerie')}
        </a>
      )}
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
    </div>
  );
}
