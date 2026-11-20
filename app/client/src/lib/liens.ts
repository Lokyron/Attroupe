/** Construction centralisée des liens internes par fragment. */

export const lienListe = (groupId: string, listeId: string): string =>
  `#/groupe/${encodeURIComponent(groupId)}/liste/${encodeURIComponent(listeId)}`;

export const lienEvenement = (groupId: string, evenementId: string): string =>
  `#/groupe/${encodeURIComponent(groupId)}/evenement/${encodeURIComponent(evenementId)}`;

export const lienAlbums = (groupId: string): string =>
  `#/groupe/${encodeURIComponent(groupId)}/albums`;

/** Un album ouvert : la route `#/groupe/:id/albums/:albumId`. */
export const lienAlbum = (groupId: string, albumId: string): string =>
  `${lienAlbums(groupId)}/${encodeURIComponent(albumId)}`;

/** Recherche de l'adresse sur OpenStreetMap : service générique, sans compte ni clé. L'adresse est encodée. */
export const lienCarte = (adresse: string): string =>
  `https://www.openstreetmap.org/search?query=${encodeURIComponent(adresse)}`;

export const lienSondage = (groupId: string, sondageId: string): string =>
  `#/groupe/${encodeURIComponent(groupId)}/sondage/${encodeURIComponent(sondageId)}`;
