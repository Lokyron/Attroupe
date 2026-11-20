import { afterEach, describe, expect, it, vi } from 'vitest';
import { ErreurApi, SESSION_EXPIREE } from '../../client/src/api/client.js';
import {
  changerMotDePasse,
  listerSessions,
  modifierProfil,
  renvoyerVerificationEmail,
  revoquerAutresSessions,
  revoquerSession,
} from '../../client/src/api/compte.js';

// Appels de l'écran Compte : méthode, chemin et corps envoyés, et lecture stricte des réponses (pas de réseau : `fetch` est simulé).

function simuler(statut: number, corps: unknown) {
  const fetchSimule = vi.fn((_url: string, _init?: RequestInit) => Promise.resolve(new Response(JSON.stringify(corps), { status: statut })));
  vi.stubGlobal('fetch', fetchSimule);
  return fetchSimule;
}

afterEach(() => vi.unstubAllGlobals());

describe('api/compte', () => {
  it('modifie le profil en n’envoyant que les champs fournis', async () => {
    const f = simuler(200, { display_name: 'Léa', time_zone: 'Europe/Paris', email_verified_at: null });
    const p = await modifierProfil({ display_name: 'Léa' });
    expect(f).toHaveBeenCalledWith('/api/moi', expect.objectContaining({ method: 'PATCH', body: '{"display_name":"Léa"}' }));
    expect(p).toEqual({ display_name: 'Léa', time_zone: 'Europe/Paris', email_verified_at: null });
  });

  it('envoie les deux mots de passe sous les noms attendus par le serveur', async () => {
    const f = simuler(200, { ok: true });
    await changerMotDePasse('ancien', 'nouveau');
    expect(f).toHaveBeenCalledWith(
      '/api/moi/mot-de-passe',
      expect.objectContaining({ method: 'POST', body: '{"current_password":"ancien","new_password":"nouveau"}' }),
    );
  });

  it('demande un nouveau lien de confirmation sans corps', async () => {
    const f = simuler(202, { ok: true });
    await renvoyerVerificationEmail();
    expect(f.mock.calls[0]?.[0]).toBe('/api/moi/email/verification');
    expect(f.mock.calls[0]?.[1]?.method).toBe('POST');
    expect(f.mock.calls[0]?.[1]?.body).toBeUndefined();
  });

  it('lit la liste des sessions et refuse une forme inattendue', async () => {
    simuler(200, {
      sessions: [{ id: 's1', created_at: 'a', last_seen_at: 'b', expires_at: 'c', user_agent: null, courante: true }],
    });
    expect(await listerSessions()).toEqual([
      { id: 's1', created_at: 'a', last_seen_at: 'b', expires_at: 'c', user_agent: null, courante: true },
    ]);
    simuler(200, { sessions: [{ id: 's1' }] });
    await expect(listerSessions()).rejects.toThrow('Réponse inattendue');
  });

  it('révoque les autres sessions et rend leur nombre', async () => {
    const f = simuler(200, { revoquees: 3 });
    expect(await revoquerAutresSessions()).toBe(3);
    expect(f).toHaveBeenCalledWith('/api/moi/sessions', expect.objectContaining({ method: 'DELETE' }));
  });

  it('encode l’identifiant d’une session et remonte le 404 en ErreurApi', async () => {
    const f = simuler(404, { error: 'session.introuvable' });
    const echec: unknown = await revoquerSession('a/b').catch((e: unknown) => e);
    expect(f.mock.calls[0]?.[0]).toBe('/api/moi/sessions/a%2Fb');
    expect(echec).toBeInstanceOf(ErreurApi);
    expect(echec).toMatchObject({ statut: 404, cle: 'session.introuvable' });
  });

  it('signale la session expirée sur un 401, sans jsdom', async () => {
    const evenements: Event[] = [];
    vi.stubGlobal('window', { dispatchEvent: (e: Event) => evenements.push(e) });
    simuler(401, { error: 'session.requise' });
    await expect(listerSessions()).rejects.toBeInstanceOf(ErreurApi);
    expect(evenements.map((e) => e.type)).toEqual([SESSION_EXPIREE]);
  });
});
