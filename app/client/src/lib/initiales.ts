/** Initiales d'un nom affiché : deux premières lettres d'un mot seul, sinon première lettre du premier et du dernier mot. « ? » si le nom est vide. */
export function initialesDe(nom: string): string {
  const morceaux = nom.trim().split(/\s+/).filter(Boolean);
  if (morceaux.length === 0) return '?';
  if (morceaux.length === 1) return (morceaux[0] ?? '?').slice(0, 2).toUpperCase();
  const premier = morceaux[0]?.[0] ?? '';
  const dernier = morceaux[morceaux.length - 1]?.[0] ?? '';
  return `${premier}${dernier}`.toUpperCase();
}
