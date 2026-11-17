import { appeler, champ, texte, texteOuNul } from './client';

export interface InfoVersion {
  name: string;
  version: string;
  tag: string;
  migration: string | null;
  migration_nom: string | null;
}

export interface EtatSante {
  status: string;
  version: string;
}

export async function lireVersion(): Promise<InfoVersion> {
  const r = await appeler('GET', '/api/version');
  return {
    name: texte(champ(r, 'name')),
    version: texte(champ(r, 'version')),
    tag: texte(champ(r, 'tag')),
    migration: texteOuNul(champ(r, 'migration')),
    migration_nom: texteOuNul(champ(r, 'migration_nom')),
  };
}

export async function lireSante(): Promise<EtatSante> {
  const r = await appeler('GET', '/api/sante');
  return {
    status: texte(champ(r, 'status')),
    version: texte(champ(r, 'version')),
  };
}
