import { randomBytes } from 'node:crypto';

// Identifiants des lignes métier : UUID v7 (RFC 9562), générés ici pour que l'appelant n'ait jamais
// à en fournir un. 48 bits d'horodatage (tri chronologique, index B-tree compact), 12 bits de
// compteur pour garder l'ordre entre deux appels de la même milliseconde, le reste est aléatoire.

let dernierInstant = 0;
let compteur = 0;

/** UUID v7 en minuscules, monotone croissant à l'intérieur du processus. */
export function nouvelIdentifiant(): string {
  let instant = Date.now();
  if (instant > dernierInstant) {
    dernierInstant = instant;
    compteur = randomBytes(2).readUInt16BE() & 0x07ff; // départ dans la moitié basse : de la marge avant débordement
  } else {
    // Même milliseconde (ou horloge reculée) : on continue la séquence au lieu de la rompre.
    instant = dernierInstant;
    compteur++;
    if (compteur > 0x0fff) {
      dernierInstant++;
      instant = dernierInstant;
      compteur = 0;
    }
  }
  const octets = Buffer.alloc(16);
  octets.writeUIntBE(instant, 0, 6);
  octets.writeUInt16BE(0x7000 | compteur, 6);
  randomBytes(8).copy(octets, 8);
  octets[8] = ((octets[8] ?? 0) & 0x3f) | 0x80; // variante RFC 4122
  const hex = octets.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
