export interface Sante {
  status: 'ok';
  version: string;
}

function estSante(valeur: unknown): valeur is Sante {
  return (
    typeof valeur === 'object' &&
    valeur !== null &&
    'status' in valeur &&
    valeur.status === 'ok' &&
    'version' in valeur &&
    typeof valeur.version === 'string'
  );
}

/** Interroge GET /api/sante ; lève une erreur si la réponse n'est pas celle attendue. */
export async function lireSante(signal?: AbortSignal): Promise<Sante> {
  const reponse = await fetch('/api/sante', signal ? { signal } : {});
  if (!reponse.ok) throw new Error(`/api/sante a répondu ${reponse.status}`);
  const corps: unknown = await reponse.json();
  if (!estSante(corps)) throw new Error('/api/sante a renvoyé un corps inattendu');
  return corps;
}
