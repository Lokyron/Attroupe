import { useEffect, useRef, useState, type DragEvent, type FormEvent } from 'react';
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
import { BarreAjout } from '../components/BarreAjout';
import { ChargementPage, SqueletteCarte } from '../components/ChargementPage';
import { DialogueConfirmation } from '../components/DialogueConfirmation';
import { EnteteGroupe } from '../components/EnteteGroupe';
import { Erreur, messageDe } from '../components/Erreur';
import { useGroupe } from '../components/FournisseurGroupe';
import { GrilleCartes } from '../components/GrilleCartes';
import { IconeCamera, IconePoubelle } from '../components/Icones';
import { fusionnerEtats, premiereErreur } from '../hooks/etatsLecture';
import { useLecture } from '../hooks/useLecture';
import { useSoumission } from '../hooks/useSoumission';
import { t } from '../i18n';
import { lienAlbum, lienAlbums } from '../lib/liens';
import { cleAccord } from '../lib/pluriel';

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

/** Page Photos / Albums Immich d'un groupe (lot 11). L'album ouvert est dans la route (`…/albums/:albumId`) : « retour » le referme. */
export function Albums({ groupId, albumId }: { groupId: string; albumId?: string | undefined }) {
  const { groupe, etat: etatGroupe, erreur: erreurGroupe, rechargerGroupe } = useGroupe();
  // `null` = fonctionnalité encore inconnue : les albums ne sont lus qu'une fois le groupe connu.
  const photosActives = groupe?.fonctionnalites.photos ?? null;
  const {
    donnees,
    etat: etatLecture,
    erreur: erreurLecture,
    recharger,
  } = useLecture(
    () => (photosActives === null ? Promise.resolve(null) : photosActives ? listerAlbums(groupId) : Promise.resolve<Album[]>([])),
    [groupId, photosActives],
  );
  // Entre l'arrivée du groupe et le relancement de la lecture, `donnees` est encore `null` en `pret` : on reste en squelette.
  const etatAlbums = photosActives !== null && donnees === null && etatLecture === 'pret' ? 'chargement' : etatLecture;
  const etat = fusionnerEtats(etatGroupe, etatAlbums);
  const erreurEcran = premiereErreur(erreurGroupe, erreurLecture);
  // Albums modifiés depuis la lecture (création, synchronisation, retrait) : prennent le pas sur ceux lus.
  const [albumsLocaux, setAlbumsLocaux] = useState<Album[] | null>(null);
  const [albumActif, setAlbumActif] = useState<Album | null>(null);
  const [photos, setPhotos] = useState<PhotoAlbum[]>([]);
  const [photoSelectionnee, setPhotoSelectionnee] = useState<PhotoAlbum | null>(null);
  const [photoARetirer, setPhotoARetirer] = useState<PhotoAlbum | null>(null);
  const [albumADetacher, setAlbumADetacher] = useState<Album | null>(null);
  const [nouveauTitre, setNouveauTitre] = useState('');
  // Envoi fichier par fichier : `fait` compte les fichiers terminés (réussis ou non), `total` ceux de la sélection.
  const [envoi, setEnvoi] = useState<{ fait: number; total: number } | null>(null);
  const annulationEnvoi = useRef<AbortController | null>(null);
  // La garde de double envoi est celle de `useSoumission` : le hook porte aussi une boucle, la progression (`envoi`) restant ici.
  const envoiSoumission = useSoumission();
  const envoiEnCours = envoiSoumission.enCours;
  // Album que la route désigne MAINTENANT : une réponse tardive (relecture après envoi, synchronisation) ne doit pas
  // reposer l'album qu'on vient de quitter. Posé dans un effet pour rester juste sous StrictMode.
  const albumCourant = useRef<string | undefined>(undefined);
  const [survolDepot, setSurvolDepot] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const creation = useSoumission();
  const synchro = useSoumission();
  const retrait = useSoumission();

  const relire = (): void => {
    setAlbumsLocaux(null);
    if (etatGroupe === 'erreur') rechargerGroupe();
    recharger();
  };
  const albums = albumsLocaux ?? donnees ?? [];
  const majAlbums = (maj: (courants: Album[]) => Album[]): void =>
    setAlbumsLocaux((precedents) => maj(precedents ?? donnees ?? []));

  /** Lit un album et ses photos (avec `forcerSync`, après resynchronisation avec Immich). Sans effet si la route a changé entre-temps. */
  const chargerAlbum = async (id: string, forcerSync = false): Promise<void> => {
    setErreur(null);
    try {
      const res = await listerPhotosAlbum(groupId, id, forcerSync);
      if (albumCourant.current !== id) return;
      setAlbumActif(res.album);
      setPhotos(res.photos);
      majAlbums((courants) => courants.map((a) => (a.id === res.album.id ? res.album : a)));
    } catch (err: unknown) {
      if (albumCourant.current !== id) return;
      setErreur(messageDe(err));
    }
  };

  // Ouvrir un album, c'est changer de route : une entrée d'historique, que « retour » referme.
  const ouvrirAlbum = (album: Album): void => {
    window.location.hash = lienAlbum(groupId, album.id);
  };

  // Changer d'album ou quitter la page coupe l'envoi en cours : sinon la boucle tournerait sans écran ni bouton d'annulation,
  // et sa progression s'afficherait sur l'album suivant.
  useEffect(() => {
    albumCourant.current = albumId;
    return () => {
      albumCourant.current = undefined;
      annulationEnvoi.current?.abort();
    };
  }, [groupId, albumId]);

  // La route fait foi : un identifiant d'album absent la referme, un identifiant inconnu laisse la liste et affiche l'erreur.
  // Rien n'est lu tant que les photos ne sont pas connues comme activées (un lien collé sur un groupe sans photos n'appelle pas Immich).
  useEffect(() => {
    if (albumId === undefined) {
      setAlbumActif(null);
      setPhotos([]);
      setPhotoSelectionnee(null);
      return;
    }
    if (photosActives !== true) return;
    let abandonne = false;
    setErreur(null);
    listerPhotosAlbum(groupId, albumId)
      .then((res) => {
        if (abandonne) return;
        setAlbumActif(res.album);
        setPhotos(res.photos);
        setAlbumsLocaux((precedents) => (precedents === null ? null : precedents.map((a) => (a.id === res.album.id ? res.album : a))));
      })
      .catch((err: unknown) => {
        if (abandonne) return;
        setAlbumActif(null);
        setPhotos([]);
        setErreur(messageDe(err));
      });
    return () => {
      abandonne = true;
    };
  }, [groupId, albumId, photosActives]);

  const soumettreCreation = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (nouveauTitre.trim() === '') return;
    setErreur(null);
    try {
      await creation.lancer(async () => {
        const cree = await creerAlbum(groupId, nouveauTitre.trim());
        setNouveauTitre('');
        majAlbums((courants) => [cree, ...courants]);
        ouvrirAlbum(cree);
      });
    } catch (err: unknown) {
      setErreur(messageDe(err));
    }
  };

  /** Envoie les fichiers un par un : la progression est réelle, et l'annulation coupe la requête en cours. */
  const envoyerFichiers = async (fichiers: FileList | readonly File[]): Promise<void> => {
    if (albumActif === null || fichiers.length === 0) return;
    const idAlbum = albumActif.id;
    const liste = Array.from(fichiers);
    await envoiSoumission.lancer(async () => {
      const controle = new AbortController();
      annulationEnvoi.current = controle;
      setErreur(null);
      setEnvoi({ fait: 0, total: liste.length });
      const echecs: string[] = [];
      let premiereErreurEnvoi: unknown = null;
      let fait = 0;
      for (const fichier of liste) {
        if (controle.signal.aborted) break;
        try {
          await televerserPhotosAlbum(groupId, idAlbum, [fichier], controle.signal);
        } catch (err: unknown) {
          if (controle.signal.aborted) break;
          echecs.push(fichier.name);
          premiereErreurEnvoi ??= err;
        }
        fait += 1;
        setEnvoi({ fait, total: liste.length });
      }
      annulationEnvoi.current = null;
      setEnvoi(null);
      // Route changée ou page quittée : l'envoi a été coupé et son compte rendu n'a plus d'écran où s'afficher.
      if (albumCourant.current !== idAlbum) return;
      const messages: string[] = [];
      // « Au moins » : une requête coupée après réception du corps par le serveur a pu ajouter sa photo sans qu'on le sache.
      if (controle.signal.aborted) messages.push(t('photos.envoi_annule', { fait: String(fait - echecs.length), total: String(liste.length) }));
      if (echecs.length > 0) {
        messages.push(t(cleAccord('photos.envoi_echecs', echecs.length), { n: String(echecs.length), noms: echecs.join(', ') }));
        messages.push(messageDe(premiereErreurEnvoi));
      }
      // Relecture même après annulation ou échec partiel : des fichiers ont pu partir.
      await chargerAlbum(idAlbum, true);
      // Concaténé, pas écrasé : la relecture a pu poser sa propre erreur, que la grille périmée rend indispensable.
      if (messages.length > 0 && albumCourant.current === idAlbum) {
        setErreur((courante) => [courante, ...messages].filter((m): m is string => m !== null && m !== '').join(' '));
      }
    });
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
        await chargerAlbum(albumActif.id);
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
        if (albumActif?.id === album.id) window.location.hash = lienAlbums(groupId);
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
        ongletActif="photos"
        titre={albumActif !== null ? albumActif.title : t('photos.titre')}
        actions={
          albumActif !== null ? (
            <div className="barre-compacte">
              <button
                type="button"
                className="bouton-compact"
                disabled={envoiEnCours}
                onClick={() => {
                  window.location.hash = lienAlbums(groupId);
                }}
              >
                {t('photos.retour_albums')}
              </button>
              <button
                type="button"
                className="bouton-compact"
                disabled={synchro.enCours}
                onClick={() => {
                  synchro.lancer(() => chargerAlbum(albumActif.id, true)).catch((err: unknown) => setErreur(messageDe(err)));
                }}
              >
                {synchro.enCours ? t('commun.chargement') : t('photos.synchroniser')}
              </button>
            </div>
          ) : undefined
        }
      />

      <Erreur message={erreur} />

      <ChargementPage etat={etat} erreur={erreurEcran} onReessayer={relire} squelette={<SqueletteCarte />}>
        {groupe !== null && !groupe.fonctionnalites.photos ? (
          <div className="carte">
            <p className="discret">{t('erreur.immich.non_configure')}</p>
          </div>
        ) : albumActif === null ? (
          <>
            <BarreAjout
              onSubmit={(e) => void soumettreCreation(e)}
              libelleBouton={creation.enCours ? t('commun.creation') : t('photos.creer_album')}
              desactive={nouveauTitre.trim() === '' || creation.enCours}
            >
              <input
                type="text"
                value={nouveauTitre}
                onChange={(e) => setNouveauTitre(e.target.value)}
                aria-label={t('photos.nouvel_album')}
                placeholder={t('photos.titre_album_exemple')}
                required
              />
            </BarreAjout>

            {albums.length === 0 ? (
              <div className="carte">
                <p className="discret">{t('photos.aucun_album')}</p>
              </div>
            ) : (
              <GrilleCartes
                elements={albums}
                cle={(a) => a.id}
                rendu={(a) => (
                  <div className="carte carte-album">
                    <button type="button" className="album-ouvrir-btn" onClick={() => ouvrirAlbum(a)}>
                      <span className="kpi-icone-badge module-icone-badge kpi-badge-ambre">
                        <IconeCamera className="icone" />
                      </span>
                      <span className="album-infos">
                        <strong className="carte-module-titre">{a.title}</strong>
                        <span className="discret ligne-meta">{t(cleAccord('photos.compteur', a.asset_count), { n: String(a.asset_count) })}</span>
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
                )}
              />
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
                    disabled={envoiEnCours}
                    onClick={() => ouvrirAlbum(a)}
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
                {envoi !== null && (
                  <button type="button" className="bouton-compact" onClick={() => annulationEnvoi.current?.abort()}>
                    {t('photos.envoi_annuler')}
                  </button>
                )}
              </div>
              {envoi !== null && (
                <div className="carte-module-progression">
                  <p role="status" className="discret ligne-meta">
                    {t('photos.envoi_progression', { courant: String(Math.min(envoi.fait + 1, envoi.total)), total: String(envoi.total) })}
                  </p>
                  <div
                    className="barre-progression"
                    role="progressbar"
                    aria-label={t('photos.envoi_en_cours')}
                    aria-valuemin={0}
                    aria-valuemax={envoi.total}
                    aria-valuenow={envoi.fait}
                  >
                    <div className="barre-progression-remplie" style={{ width: `${(envoi.fait / envoi.total) * 100}%` }} />
                  </div>
                </div>
              )}
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
