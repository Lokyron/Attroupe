/** Erreur HTTP typée : statut, clé de traduction (renvoyée au client) et, au besoin, délai avant nouvel essai. */
export class ErreurHttp extends Error {
  constructor(
    public readonly statut: number,
    /** Clé stable `domaine.cas`, que le client traduit. Jamais un texte, jamais une donnée personnelle. */
    public readonly cle: string,
    public readonly retryApresSecondes?: number,
    /** Noms des champs refusés (validation) : jamais leurs valeurs. */
    public readonly champs?: readonly string[],
  ) {
    super(cle);
    this.name = 'ErreurHttp';
  }
}
