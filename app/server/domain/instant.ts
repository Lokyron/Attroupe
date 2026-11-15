// Instants au format du modèle de données (§1) : ISO 8601 UTC, secondes, suffixe Z. Logique pure,
// l'horloge est toujours passée par l'appelant (les tests avancent le temps sans attendre).

/** `AAAA-MM-JJTHH:MM:SSZ` : l'ordre lexicographique est l'ordre chronologique. */
export function versInstant(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Relit un instant écrit par `versInstant`. */
export function depuisInstant(instant: string): Date {
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) throw new Error(`Instant illisible : « ${instant} ».`);
  return date;
}

/** `date` décalée de `ms` millisecondes. */
export function plus(date: Date, ms: number): Date {
  return new Date(date.getTime() + ms);
}

export const SECONDE_MS = 1000;
export const MINUTE_MS = 60 * SECONDE_MS;
export const HEURE_MS = 60 * MINUTE_MS;
export const JOUR_MS = 24 * HEURE_MS;
