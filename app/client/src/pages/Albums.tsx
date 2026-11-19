import { useEffect, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { lireGroupe } from '../api/groupes';
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
import { ChargementPage, SqueletteCarte } from '../components/ChargementPage';
import { DialogueConfirmation } from '../components/DialogueConfirmation';
import { EnteteGroupe } from '../components/EnteteGroupe';
import { Erreur, messageDe } from '../components/Erreur';
import { IconeCamera, IconePoubelle } from '../components/Icones';
import { useLecture } from '../hooks/useLecture';
import { useSoumission } from '../hooks/useSoumission';
import { t } from '../i18n';

/**
 * Visionneuse plein écran bâtie sur `<dialog>` + `showModal()` : focus déplacé à l'ouverture et piégé, fermeture par Échap,
 * reste de la page inerte. Elle n'est montée que pendant qu'une photo est ouverte ; au démontage, le focus retourne à la
 * vignette d'origine et le défilement de la page est rendu.
 */
function Visionneuse({ photo, onFermer }: { photo: PhotoAlbum; onFermer: () => void }) {
  const dialogue = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = dialogue.current;
    if (el === null) return;
    const ouvrant = document.activeElement;
    const debordement = document.body.style.overflow;
    el.showModal();
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = debordement;
      if (el.open) el.close();
      if (ouvrant instanceof HTMLElement) ouvrant.focus();
    };
  }, []);

  return (
    <dialog
      ref={dialogue}
      aria-label={t('photos.visionneuse')}
      // Le fond sombre et la mise en page viennent du conteneur `.visionneuse-modale` : le dialogue
      // n'est qu'un cadre transparent, décrit par `dialog.visionneuse` dans la feuille de style.
      className="visionneuse"
      onCancel={(e) => {
        e.preventDefault();
        onFermer();
      }}
    >
      <div className="visionneuse-modale">
        <div className="visionneuse-barre">
          <button type="button" onClick={onFermer}>
            {t('photos.fermer_visionneuse')}
          </button>
          <a className="bouton bouton-primaire" href={photo.original_url} target="_blank" rel="noreferrer">
            {t('photos.telecharger_original')}
          </a>
        </div>
        <img src={photo.preview_url} alt={t('photos.apercu_alt')} className="visionneuse-image" />
      </div>
    </dialog>
  );
}

/** Page Photos / Albums Immich d'un groupe (lot 11). */
export function Albums({ groupId }: { groupId: string }) {
  const {
    donnees,
    etat,
    erreur: erreurLecture,
    recharger,
  } = useLecture(async () => {
    const g = await lireGroupe(groupId);
    const liste = g.fonctionnalites.photos ? await listerAlbums(groupId) : [];
    return { groupe: g, albums: liste };
  }, [groupId]);
  // Albums modifiés depuis la lecture (création, synchronisation, retrait) : prennent le pas sur ceux lus.
  const [albumsLocaux, setAlbumsLocaux] = useState<Album[] | null>(null);
  const [albumActif, setAlbumActif] = useState<Album | null>(null);
  const [photos, setPhotos] = useState<PhotoAlbum[]>([]);
  const [photoSelectionnee, setPhotoSelectionnee] = useState<PhotoAlbum | null>(null);
  const [photoARetirer, setPhotoARetirer] = useState<PhotoAlbum | null>(null);
  const [albumADetacher, setAlbumADetacher] = useState<Album | null>(null);
  const [nouveauTitre, setNouveauTitre] = useState('');
  const [envoiEnCours, setEnvoiEnCours] = useState(false);
  const [survolDepot, setSurvolDepot] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const creation = useSoumission();
  const synchro = useSoumission();
  const retrait = useSoumission();

  const relire = (): void => {
    setAlbumsLocaux(null);
    recharger();
  };
  const groupe = donnees?.groupe ?? null;
  const albums = albumsLocaux ?? donnees?.albums ?? [];
  const majAlbums = (maj: (courants: Album[]) => Album[]): void =>
    setAlbumsLocaux((precedents) => maj(precedents ?? donnees?.albums ?? []));

  const ouvrirAlbum = async (album: Album, forcerSync = false): Promise<void> => {
    setErreur(null);
    try {
      const res = await listerPhotosAlbum(groupId, album.id, forcerSync);
      setAlbumActif(res.album);
      setPhotos(res.photos);
      majAlbums((courants) => courants.map((a) => (a.id === res.album.id ? res.album : a)));
    } catch (err: unknown) {
      setErreur(messageDe(err));
    }
  };

  const soumettreCreation = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (nouveauTitre.trim() === '') return;
    setErreur(null);
    try {
      await creation.lancer(async () => {
        const cree = await creerAlbum(groupId, nouveauTitre.trim());
        setNouveauTitre('');
        majAlbums((courants) => [cree, ...courants]);
        await ouvrirAlbum(cree);
      });
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
    setErreur(null);
    try {
      await retrait.lancer(async () => {
        await retirerPhotoAlbum(groupId, albumActif.id, photo.immich_asset_id);
        if (photoSelectionnee?.immich_asset_id === photo.immich_asset_id) {
          setPhotoSelectionnee(null);
        }
        await ouvrirAlbum(albumActif);
      });
    } catch (err: unknown) {
      setErreur(messageDe(err));
    }
  };

  const detacherAlbum = async (album: Album): Promise<void> => {
    setErreur(null);
    try {
      await retrait.lancer(async () => {
        await supprimerAlbum(groupId, album.id);
        if (albumActif?.id === album.id) {
          setAlbumActif(null);
          setPhotos([]);
        }
        // Retrait local : pas de relecture, donc pas de squelette ni de clignotement.
        majAlbums((courants) => courants.filter((a) => a.id !== album.id));
      });
    } catch (err: unknown) {
      setErreur(messageDe(err));
    }
  };

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
              <button
                type="button"
                className="bouton-compact"
                disabled={synchro.enCours}
                onClick={() => {
                  synchro.lancer(() => ouvrirAlbum(albumActif, true)).catch((err: unknown) => setErreur(messageDe(err)));
                }}
              >
                {synchro.enCours ? t('commun.chargement') : t('photos.synchroniser')}
              </button>
            </div>
          ) : undefined
        }
      />

      <Erreur message={erreur} />

      <ChargementPage etat={etat} erreur={erreurLecture} onReessayer={relire} squelette={<SqueletteCarte />}>
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
              <button type="submit" disabled={nouveauTitre.trim() === '' || creation.enCours}>
                {creation.enCours ? t('commun.creation') : t('photos.creer_album')}
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
                      onClick={() => setAlbumADetacher(a)}
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
                      groupe !== null && (groupe.mon_role === 'admin' || p.uploaded_by_membership_id === groupe.mon_appartenance_id);
                    return (
                      <figure key={p.immich_asset_id} className="vignette-photo-album">
                        <button
                          type="button"
                          className="vignette-photo-bento vignette-photo-bouton"
                          onClick={() => setPhotoSelectionnee(p)}
                        >
                          <img src={p.thumbnail_url} alt={t('photos.vignette_alt')} loading="lazy" decoding="async" />
                        </button>
                        {peutRetirer && (
                          <button
                            type="button"
                            className="bouton-retirer-photo"
                            aria-label={t('photos.retirer')}
                            onClick={() => setPhotoARetirer(p)}
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

            {photoSelectionnee !== null && <Visionneuse photo={photoSelectionnee} onFermer={() => setPhotoSelectionnee(null)} />}
          </>
        )}
      </ChargementPage>

      <DialogueConfirmation
        ouvert={photoARetirer !== null}
        titre={t('confirm.photos.retirer.titre')}
        consequence={t('confirm.photos.retirer.consequence')}
        reversible={true}
        libelleConfirmer={t('confirm.photos.retirer.action')}
        danger={false}
        onConfirmer={() => {
          if (photoARetirer !== null) void retirerPhoto(photoARetirer);
          setPhotoARetirer(null);
        }}
        onAnnuler={() => setPhotoARetirer(null)}
      />
      <DialogueConfirmation
        ouvert={albumADetacher !== null}
        titre={t('confirm.photos.supprimer_album.titre')}
        consequence={t('confirm.photos.supprimer_album.consequence')}
        reversible={true}
        libelleConfirmer={t('confirm.photos.supprimer_album.action')}
        danger={false}
        onConfirmer={() => {
          if (albumADetacher !== null) void detacherAlbum(albumADetacher);
          setAlbumADetacher(null);
        }}
        onAnnuler={() => setAlbumADetacher(null)}
      />
    </section>
  );
}
