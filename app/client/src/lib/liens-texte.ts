/** Détection des adresses web dans un texte libre. Le résultat est une liste de morceaux à rendre en nœuds React : jamais de HTML construit par chaîne. */

export type MorceauTexte =
  | { readonly type: 'texte'; readonly texte: string }
  | { readonly type: 'lien'; readonly texte: string; readonly href: string };

// Seuls `http://` et `https://` sont reconnus : `javascript:`, `data:` ou `mailto:` ne forment jamais un lien.
const MOTIF_URL = /https?:\/\/[^\s<>"]+/gi;

// Ponctuation de phrase qui n'appartient pas à l'adresse quand elle la termine.
const PONCTUATION_FINALE = new Set(['.', ',', ';', ':', '!', '?', "'", '"', '»', '…', '’']);
const FERMANTES: Readonly<Record<string, string>> = { ')': '(', ']': '[', '}': '{' };

function compter(texte: string, caractere: string): number {
  let n = 0;
  for (const c of texte) if (c === caractere) n += 1;
  return n;
}

/** Retire de la fin de l'adresse la ponctuation de phrase et les fermantes sans ouvrante (« (voir https://a.fr) »). */
function sansFin(brut: string): string {
  let url = brut;
  for (;;) {
    const dernier = url.slice(-1);
    const ouvrante = FERMANTES[dernier];
    if (PONCTUATION_FINALE.has(dernier) || (ouvrante !== undefined && compter(url, dernier) > compter(url, ouvrante))) {
      url = url.slice(0, -1);
    } else {
      return url;
    }
  }
}

/** L'adresse normalisée si la chaîne est une URL absolue http(s) avec un hôte, `null` sinon. */
function urlWebValide(candidate: string): string | null {
  try {
    const url = new URL(candidate);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.hostname === '') return null;
    return url.href;
  } catch {
    return null;
  }
}

/** Découpe `texte` en morceaux de texte et de liens ; la concaténation des `texte` redonne toujours l'entrée. */
export function decouperLiens(texte: string): MorceauTexte[] {
  const morceaux: MorceauTexte[] = [];
  const ajouterTexte = (suite: string): void => {
    if (suite === '') return;
    const dernier = morceaux[morceaux.length - 1];
    if (dernier?.type === 'texte') morceaux[morceaux.length - 1] = { type: 'texte', texte: dernier.texte + suite };
    else morceaux.push({ type: 'texte', texte: suite });
  };
  let curseur = 0;
  for (const correspondance of texte.matchAll(MOTIF_URL)) {
    const debut = correspondance.index;
    const visible = sansFin(correspondance[0]);
    const href = urlWebValide(visible);
    ajouterTexte(texte.slice(curseur, debut));
    if (href === null) {
      ajouterTexte(correspondance[0]);
    } else {
      morceaux.push({ type: 'lien', texte: visible, href });
      ajouterTexte(correspondance[0].slice(visible.length));
    }
    curseur = debut + correspondance[0].length;
  }
  ajouterTexte(texte.slice(curseur));
  return morceaux;
}
