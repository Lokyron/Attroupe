/** Construction centralisée des liens internes par fragment. */

export const lienListe = (groupId: string, listeId: string): string =>
  `#/groupe/${encodeURIComponent(groupId)}/liste/${encodeURIComponent(listeId)}`;

export const lienEvenement = (groupId: string, evenementId: string): string =>
  `#/groupe/${encodeURIComponent(groupId)}/evenement/${encodeURIComponent(evenementId)}`;

export const lienAlbums = (groupId: string): string =>
  `#/groupe/${encodeURIComponent(groupId)}/albums`;
