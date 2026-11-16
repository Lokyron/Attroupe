// Format iCalendar (RFC 5545) du flux de calendrier (architecture §7.1). Logique PURE : ni base, ni Express.
//
// Trois règles de forme, qui sont aussi les trois façons de casser un flux sans que le serveur s'en aperçoive :
//  - toute ligne se termine par CRLF ;
//  - une ligne dépasse rarement 75 OCTETS (pas 75 caractères) : on la plie, et jamais au milieu d'un caractère UTF-8
//    (une coupure dans « é » rend le flux illisible chez certains clients) ;
//  - dans une valeur de texte, `\`, `;`, `,` et les retours à la ligne sont échappés. Un titre n'ouvre donc jamais une
//    nouvelle propriété (« x\r\nATTENDEE:… » reste une seule ligne de SUMMARY).
//
// Les événements à l'heure sont émis en UTC (`DTSTART:…Z`) : la base stocke un INSTANT, et pour un événement non récurrent
// un instant est un instant — `TZID` + `VTIMEZONE` n'ajouterait que des règles de changement d'heure à maintenir à la main.
// Le fuseau d'origine n'est pas perdu : il est écrit dans `DESCRIPTION`. Les journées entières sont des dates (`VALUE=DATE`).
// `TZID` redeviendra nécessaire avec la récurrence (V2).

const CRLF = '\r\n';
const LIMITE_OCTETS = 75;
const PRODID = '-//Attroupe//Flux iCal//FR';
/** Origine de `SEQUENCE` : un entier 32 bits en secondes tient jusqu'en 2094. */
const ORIGINE_SEQUENCE_MS = Date.UTC(2026, 0, 1);

/** Retire les caractères de commande, sauf la tabulation et les retours à la ligne (traités à part) quand `garderLignes`. */
function sansCommande(valeur: string, garderLignes: boolean): string {
  let sortie = '';
  for (const caractere of valeur) {
    const code = caractere.codePointAt(0) ?? 0;
    const commande = code < 0x20 || code === 0x7f;
    if (!commande || code === 0x09 || (garderLignes && code === 0x0a)) sortie += caractere;
  }
  return sortie;
}

/** Échappe une valeur de type TEXT (RFC 5545 §3.3.11) ; les retours à la ligne deviennent `\n`, les autres caractères de commande disparaissent. */
export function echapperTexte(valeur: string): string {
  return sansCommande(valeur.replace(/\r\n|\r/g, '\n'), true)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

/** Valeur de paramètre (`CN=…`) : toujours entre guillemets, sans guillemet ni caractère de commande à l'intérieur. */
function valeurParametre(valeur: string): string {
  return `"${sansCommande(valeur, false).replace(/"/g, '')}"`;
}

const encodeur = new TextEncoder();

/**
 * Plie une ligne logique en lignes de 75 octets UTF-8 au plus (continuations introduites par une espace, comptée dans les 75).
 * Le résultat est joint par CRLF, sans CRLF final. Un caractère n'est jamais coupé.
 */
export function plierLigne(ligne: string): string {
  const morceaux: string[] = [];
  let courant = '';
  let octets = 0;
  let limite = LIMITE_OCTETS;
  for (const caractere of ligne) {
    const taille = encodeur.encode(caractere).length;
    if (octets + taille > limite) {
      morceaux.push(courant);
      courant = ' ';
      octets = 1;
      limite = LIMITE_OCTETS;
    }
    courant += caractere;
    octets += taille;
  }
  morceaux.push(courant);
  return morceaux.join(CRLF);
}

/** Lignes logiques → texte iCalendar : chacune pliée, chacune terminée par CRLF. */
export function serialiser(lignes: readonly string[]): string {
  return lignes.map((l) => plierLigne(l) + CRLF).join('');
}

/** `2027-03-20T18:00:00Z` → `20270320T180000Z`. */
function instantIcal(instant: string): string {
  return instant.replace(/[-:]/g, '');
}

/** `2027-03-20` → `20270320`. */
function dateIcal(date: string): string {
  return date.replace(/-/g, '');
}

/** Lendemain d'une date civile (la fin d'un événement sur journée entière est EXCLUSIVE en iCalendar). */
function lendemain(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** `SEQUENCE` dérivé de `updated_at` : croît à chaque modification, sans compteur à stocker. */
export function sequenceDe(modifieLe: string): number {
  return Math.max(0, Math.floor((new Date(modifieLe).getTime() - ORIGINE_SEQUENCE_MS) / 1000));
}

export interface EvenementIcal {
  readonly id: string;
  readonly groupe: string;
  readonly titre: string;
  readonly description: string | null;
  readonly lieuNom: string | null;
  readonly lieuAdresse: string | null;
  readonly consignes: string | null;
  readonly journeeEntiere: boolean;
  /** Instant UTC `AAAA-MM-JJTHH:MM:SSZ`, ou date `AAAA-MM-JJ` pour une journée entière. */
  readonly debut: string;
  /** Même format que `debut` ; pour une journée entière, la DERNIÈRE journée (inclusive, comme en base). */
  readonly fin: string | null;
  readonly fuseau: string;
  readonly annule: boolean;
  /** `updated_at` de l'événement : DTSTAMP, LAST-MODIFIED et SEQUENCE en dérivent. */
  readonly modifieLe: string;
  readonly organisateur: string;
  /** Lien vers l'événement dans l'application. Jamais le jeton du flux. */
  readonly lien: string;
}

/** Libellé de lieu : « Nom, adresse », ou ce qui existe. */
function lieuDe(e: Pick<EvenementIcal, 'lieuNom' | 'lieuAdresse'>): string | null {
  const morceaux = [e.lieuNom, e.lieuAdresse].filter((m): m is string => m !== null && m !== '');
  return morceaux.length === 0 ? null : morceaux.join(', ');
}

/** Corps de `DESCRIPTION` : description, lieu, consignes, fuseau d'origine, lien. Une seule valeur de texte, lignes séparées par `\n`. */
function descriptionDe(e: EvenementIcal, libelles: LibellesIcal): string {
  const lieu = lieuDe(e);
  const parties = [
    e.description,
    lieu === null ? null : `${libelles.lieu} : ${lieu}`,
    e.consignes === null || e.consignes === '' ? null : `${libelles.consignes} : ${e.consignes}`,
    `${libelles.fuseau} : ${e.fuseau}`,
    `${libelles.lien} : ${e.lien}`,
  ];
  return parties.filter((p): p is string => p !== null && p !== '').join('\n');
}

/** Textes fixes du flux : fournis par l'appelant (fr.json du serveur), pas écrits ici. */
export interface LibellesIcal {
  readonly lieu: string;
  readonly consignes: string;
  readonly fuseau: string;
  readonly lien: string;
}

function lignesEvenement(e: EvenementIcal, libelles: LibellesIcal): string[] {
  const lignes = [
    'BEGIN:VEVENT',
    `UID:${e.id}@attroupe`,
    `DTSTAMP:${instantIcal(e.modifieLe)}`,
    `LAST-MODIFIED:${instantIcal(e.modifieLe)}`,
    `SEQUENCE:${String(sequenceDe(e.modifieLe))}`,
  ];
  if (e.journeeEntiere) {
    lignes.push(`DTSTART;VALUE=DATE:${dateIcal(e.debut)}`);
    lignes.push(`DTEND;VALUE=DATE:${dateIcal(lendemain(e.fin ?? e.debut))}`);
  } else {
    lignes.push(`DTSTART:${instantIcal(e.debut)}`);
    if (e.fin !== null) lignes.push(`DTEND:${instantIcal(e.fin)}`);
  }
  lignes.push(`SUMMARY:${echapperTexte(`[${e.groupe}] ${e.titre}`)}`);
  const lieu = lieuDe(e);
  if (lieu !== null) lignes.push(`LOCATION:${echapperTexte(lieu)}`);
  lignes.push(`DESCRIPTION:${echapperTexte(descriptionDe(e, libelles))}`);
  // Aucune adresse e-mail n'est divulguée : l'URI est obligatoire en iCalendar, `.invalid` ne désigne personne (RFC 2606).
  lignes.push(`ORGANIZER;CN=${valeurParametre(e.organisateur)}:mailto:organisateur@attroupe.invalid`);
  lignes.push(`STATUS:${e.annule ? 'CANCELLED' : 'CONFIRMED'}`);
  lignes.push('END:VEVENT');
  return lignes;
}

/** Le VCALENDAR complet (CRLF partout, lignes pliées). `nom` est le nom affiché du calendrier. */
export function genererCalendrier(nom: string, evenements: readonly EvenementIcal[], libelles: LibellesIcal): string {
  return serialiser([
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${PRODID}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${echapperTexte(nom)}`,
    ...evenements.flatMap((e) => lignesEvenement(e, libelles)),
    'END:VCALENDAR',
  ]);
}
