// Type de la connexion tel que le voit le reste de l'application : OPAQUE. Il ne porte aucune
// méthode (ni `prepare`, ni `exec`, ni `pragma`) : hors de db/, une connexion ne sert qu'à être
// transmise à `creerScope` & co. La vraie connexion reste dans `connection.ts` (ADR-0008).
declare const marque: unique symbol;

export interface Base {
  readonly [marque]: true;
}
