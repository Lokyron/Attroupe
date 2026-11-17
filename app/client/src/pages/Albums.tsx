import { useCallback, useEffect, useState, type DragEvent, type FormEvent } from 'react';
import { lireGroupe, type DetailGroupe } from '../api/groupes';
import {
  creerAlbum,
  listerAlbums,
  listerPhotosAlbum,
  retirerPhotoAlbum,
  supprimerAlbum,
  televerserPhotosAlbum,
  type Album,
  type PhotoAlbum,
} from '../api/immich';
import { EnteteGroupe } from '../components/EnteteGroupe';
import { Erreur, messageDe } from '../components/Erreur';
import { IconeCamera, IconePoubelle } from '../components/Icones';
import { t } from '../i18n';

/** Page Photos / Albums Immich d'un groupe (lot 11). */
export function Albums({ groupId }: { groupId: string }) {
  const [groupe, setGroupe] = useState<DetailGroupe | null>(null);
  const [albums, setAlbums] = useState<Album[]>([]);
  const [albumActif, setAlbumActif] = useState<Album | null>(null);
  const [photos, setPhotos] = useState<PhotoAlbum[]>([]);
  const [photoSelectionnee, setPhotoSelectionnee] = useState<PhotoAlbum | null>(null);
  const [nouveauTitre, setNouveauTitre] = useState('');
  const [chargement, setChargement] = useState(true);
  const [envoiEnCours, setEnvoiEnCours] = useState(false);
  const [survolDepot, setSurvolDepot] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);

  const chargerAlbums = useCallback(async (): Promise<void> => {
    setErreur(null);
    setChargement(true);
    try {
      const g = await lireGroupe(groupId);
      setGroupe(g);
      if (!g.fonctionnalites.photos) {
        setAlbums([]);
        return;
      }
      const listeAlbums = await listerAlbums(groupId);
      setAlbums(listeAlbums);
    } catch (err: unknown) {
      setErreur(messageDe(err));
    } finally {
      setChargement(false);
    }
  }, [groupId]);

  useEffect(() => {
    void chargerAlbums();
  }, [chargerAlbums]);

  const ouvrirAlbum = async (album: Album, forcerSync = false): Promise<void> => {
    setErreur(null);
    try {
      const res = await listerPhotosAlbum(groupId, album.id, forcerSync);
      setAlbumActif(res.album);
      setPhotos(res.photos);
      setAlbums((courants) => courants.map((a) => (a.id === res.album.id ? res.album : a)));
    } catch (err: unknown) {
      setErreur(messageDe(err));
    }
  };

  const soumettreCreation = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (nouveauTitre.trim() === '') return;
    setErreur(null);
    try {
      const cree = await creerAlbum(groupId, nouveauTitre.trim());
      setNouveauTitre('');
      setAlbums((courants) => [cree, ...courants]);
      await ouvrirAlbum(cree);
    } catch (err: unknown) {
      setErreur(messageDe(err));
    }
  };

  const envoyerFichiers = async (fichiers: FileList | readonly File[]): Promise<void> => {
    if (albumActif === null || fichiers.length === 0) return;
    setErreur(null);
    setEnvoiEnCours(true);
    try {
      await televerserPhotosAlbum(groupId, albumActif.id, fichiers);
      await ouvrirAlbum(albumActif, true);
    } catch (err: unknown) {
      setErreur(messageDe(err));
    } finally {
      setEnvoiEnCours(false);
    }
  };

  const surDepot = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    setSurvolDepot(false);
    if (e.dataTransfer.files.length > 0) {
      void envoyerFichiers(e.dataTransfer.files);
    }
  };

  const retirerPhoto = async (photo: PhotoAlbum): Promise<void> => {
    if (albumActif === null) return;
    if (!window.confirm(t('photos.retirer_confirmation'))) return;
    setErreur(null);
    try {
      await retirerPhotoAlbum(groupId, albumActif.id, photo.immich_asset_id);
      if (photoSelectionnee?.immich_asset_id === photo.immich_asset_id) {
        setPhotoSelectionnee(null);
      }
      await ouvrirAlbum(albumActif);
    } catch (err: unknown) {
      setErreur(messageDe(err));
    }
  };

  const detacherAlbum = async (album: Album): Promise<void> => {
    if (!window.confirm(t('photos.supprimer_album_confirmation'))) return;
    setErreur(null);
    try {
      await supprimerAlbum(groupId, album.id);
      if (albumActif?.id === album.id) {
        setAlbumActif(null);
        setPhotos([]);
      }
      await chargerAlbums();
    } catch (err: unknown) {
      setErreur(messageDe(err));
    }
  };

  if (chargement) return <p className="discret">{t('commun.chargement')}</p>;

  return (
    <section className="page-groupe-pile">
      <EnteteGroupe
        groupId={groupId}
        ongletActif="photos"
        nomGroupe={groupe?.name}
        photosActives={groupe?.fonctionnalites.photos}
        titre={albumActif !== null ? albumActif.title : t('photos.titre')}
        actions={
          albumActif !== null ? (
            <div className="barre-compacte">
              <button
                type="button"
                className="bouton-compact"
                onClick={() => {
                  setAlbumActif(null);
                  setPhotos([]);
                  setPhotoSelectionnee(null);
                }}
              >
                {t('photos.retour_albums')}
              </button>
              <button type="button" className="bouton-compact" onClick={() => void ouvrirAlbum(albumActif, true)}>
                {t('photos.synchroniser')}
              </button>
            </div>
          ) : undefined
        }
      />

      <Erreur message={erreur} />

      {groupe !== null && !groupe.fonctionnalites.photos ? (
        <div className="carte">
          <p className="discret">{t('erreur.immich.non_configure')}</p>
        </div>
      ) : albumActif === null ? (
        <>
          <form onSubmit={(e) => void soumettreCreation(e)} className="carte barre-ajout-ligne">
            <input
              type="text"
              value={nouveauTitre}
              onChange={(e) => setNouveauTitre(e.target.value)}
              aria-label={t('photos.nouvel_album')}
              placeholder={t('photos.titre_album_exemple')}
              required
            />
            <button type="submit" disabled={nouveauTitre.trim() === ''}>
              {t('photos.creer_album')}
            </button>
          </form>

          {albums.length === 0 ? (
            <div className="carte">
              <p className="discret">{t('photos.aucun_album')}</p>
            </div>
          ) : (
            <div className="grille-cartes-module">
              {albums.map((a) => (
                <div key={a.id} className="carte carte-album">
                  <button type="button" className="album-ouvrir-btn" onClick={() => void ouvrirAlbum(a)}>
                    <span className="kpi-icone-badge module-icone-badge kpi-badge-ambre">
                      <IconeCamera className="icone" />
                    </span>
                    <span className="album-infos">
                      <strong className="carte-module-titre">{a.title}</strong>
                      <span className="discret ligne-meta">{t('photos.compteur', { n: String(a.asset_count) })}</span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="bouton-icone-discret"
                    aria-label={t('photos.supprimer_album')}
                    onClick={() => void detacherAlbum(a)}
                  >
                    <IconePoubelle className="icone-mini" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          {albums.length > 1 && (
            <div className="pilules-albums" role="navigation" aria-label={t('photos.titre')}>
              {albums.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  className="pilule-nav"
                  aria-pressed={a.id === albumActif.id}
                  onClick={() => void ouvrirAlbum(a)}
                >
                  {a.title}
                </button>
              ))}
            </div>
          )}

          <div
            className={`carte zone-depot-photos${survolDepot ? ' zone-depot-active' : ''}`}
            onDragOver={(e) => {
              e.preventDefault();
              setSurvolDepot(true);
            }}
            onDragLeave={() => setSurvolDepot(false)}
            onDrop={surDepot}
          >
            <p className="discret">{t('photos.zone_depot')}</p>
            <div className="barre-compacte">
              <label className="bouton bouton-primaire label-fichier">
                <span>{t('photos.choisir_fichiers')}</span>
                <input
                  type="file"
                  accept="image/*,video/*"
                  multiple
                  disabled={envoiEnCours}
                  className="input-fichier-cache"
                  onChange={(e) => {
                    if (e.target.files !== null && e.target.files.length > 0) {
                      void envoyerFichiers(e.target.files);
                      e.target.value = '';
                    }
                  }}
                />
              </label>
              {envoiEnCours && <span className="pilule pilule-statut-maybe">{t('photos.envoi_en_cours')}</span>}
            </div>
          </div>

          <div className="carte">
            {photos.length === 0 ? (
              <p className="discret">{t('photos.aucune_photo')}</p>
            ) : (
              <div className="grille-photos-bento">
                {photos.map((p) => {
                  const peutRetirer =
                    groupe !== null &&
                    (groupe.mon_role === 'admin' || p.uploaded_by_membership_id === groupe.mon_appartenance_id);
                  return (
                    <figure key={p.immich_asset_id} className="vignette-photo-album">
                      <button
                        type="button"
                        className="vignette-photo-bento vignette-photo-bouton"
                        onClick={() => setPhotoSelectionnee(p)}
                      >
                        <img src={p.thumbnail_url} alt={t('photos.vignette_alt')} />
                      </button>
                      {peutRetirer && (
                        <button
                          type="button"
                          className="bouton-retirer-photo"
                          aria-label={t('photos.retirer')}
                          onClick={() => void retirerPhoto(p)}
                        >
                          <IconePoubelle className="icone-mini" />
                        </button>
                      )}
                    </figure>
                  );
                })}
              </div>
            )}
          </div>

          {photoSelectionnee !== null && (
            <div role="dialog" aria-modal="true" aria-label={t('photos.visionneuse')} className="visionneuse-modale">
              <div className="visionneuse-barre">
                <button type="button" onClick={() => setPhotoSelectionnee(null)}>
                  {t('photos.fermer_visionneuse')}
                </button>
                <a className="bouton bouton-primaire" href={photoSelectionnee.original_url} target="_blank" rel="noreferrer">
                  {t('photos.telecharger_original')}
                </a>
              </div>
              <img src={photoSelectionnee.preview_url} alt={t('photos.apercu_alt')} className="visionneuse-image" />
            </div>
          )}
        </>
      )}
    </section>
  );
}
