// Sans import : testable seul, comme agenda/dates.ts.

/** Lien « S'abonner » de Google Agenda (version web, ordinateur) : l'adresse `https` du flux, encodée, dans `cid`. */
export function lienGoogleAgenda(urlHttps: string): string {
  return `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(urlHttps)}`;
}
