import { describe, expect, it } from 'vitest';
import { evaluerMotDePasse } from '../../server/domain/mot-de-passe.js';
import { doitEtreRehache, empreinteLeurre, hacher, PARAMETRES_PRODUCTION, verifier } from '../../server/services/mot-de-passe.js';

const LEGER = { N: 1024, r: 8, p: 1 } as const;

describe('force du mot de passe', () => {
  it('accepte une phrase de passe correcte', () => {
    expect(evaluerMotDePasse('correct-cheval-pile-agrafe')).toBeUndefined();
    expect(evaluerMotDePasse('Un été à Marseille, 2026 !')).toBeUndefined();
  });

  it('refuse sous 10 caractères (comptés en caractères, pas en octets)', () => {
    expect(evaluerMotDePasse('Abc!9xyz')).toBe('mot_de_passe.trop_court');
    expect(evaluerMotDePasse('éééééééé!')).toBe('mot_de_passe.trop_court'); // 9 caractères, 17 octets
  });

  it('refuse au-delà de 128 caractères', () => {
    expect(evaluerMotDePasse('a1B'.repeat(50))).toBe('mot_de_passe.trop_long');
  });

  it.each(['password123!', 'Password1234', 'p@ssw0rd2024', 'MotDePasse99', 'azertyuiop', 'Azerty123456', 'qwertyuiop12', 'Jetaime2026!!'])(
    'refuse le mot de passe courant « %s »',
    (mdp) => {
      expect(evaluerMotDePasse(mdp)).toBeDefined();
    },
  );

  it.each(['1234567890', '0987654321', 'aaaaaaaaaaaa', 'abababababab', '1111122222', 'abcdefghijkl'])('refuse le mot de passe trivial « %s »', (mdp) => {
    expect(evaluerMotDePasse(mdp)).toBe('mot_de_passe.trop_simple');
  });

  it('refuse un mot de passe qui contient le nom d’utilisateur ou l’adresse', () => {
    expect(evaluerMotDePasse('alice-martin-2026-x', { identifiants: ['alicemartin'] })).toBeUndefined();
    expect(evaluerMotDePasse('xx-AliceMartin-vert', { identifiants: ['alicemartin'] })).toBe('mot_de_passe.contient_identifiant');
  });
});

describe('hachage scrypt', () => {
  it('produit le format versionné scrypt$N$r$p$sel$empreinte avec les paramètres de l’ADR-0007', async () => {
    const h = await hacher('correct-cheval-pile-agrafe', PARAMETRES_PRODUCTION);
    const [nom, N, r, p, sel, empreinte] = h.split('$');
    expect([nom, N, r, p]).toEqual(['scrypt', '32768', '8', '1']);
    expect(Buffer.from(sel ?? '', 'base64url')).toHaveLength(16);
    expect(Buffer.from(empreinte ?? '', 'base64url')).toHaveLength(64);
  });

  it('vérifie le bon mot de passe, refuse les autres, sel différent à chaque fois', async () => {
    const a = await hacher('correct-cheval-pile-agrafe', LEGER);
    const b = await hacher('correct-cheval-pile-agrafe', LEGER);
    expect(a).not.toBe(b);
    expect(await verifier('correct-cheval-pile-agrafe', a)).toBe(true);
    expect(await verifier('correct-cheval-pile-agrafe ', a)).toBe(false);
    expect(await verifier('', a)).toBe(false);
  });

  it('relit les paramètres dans l’empreinte : un ancien hachage reste vérifiable et se signale à refaire', async () => {
    const ancien = await hacher('correct-cheval-pile-agrafe', LEGER);
    expect(await verifier('correct-cheval-pile-agrafe', ancien)).toBe(true);
    expect(doitEtreRehache(ancien, PARAMETRES_PRODUCTION)).toBe(true);
    expect(doitEtreRehache(ancien, LEGER)).toBe(false);
  });

  it('refuse sans planter une empreinte illisible ou aux paramètres démesurés', async () => {
    expect(await verifier('x', 'pas-un-hachage')).toBe(false);
    expect(await verifier('x', 'scrypt$1073741824$8$1$AAAA$AAAA')).toBe(false); // N = 2^30 : refusé avant tout calcul
    expect(await verifier('x', 'scrypt$1000$8$1$AAAA$AAAA')).toBe(false); // N n'est pas une puissance de 2
  });

  it('l’empreinte leurre a les mêmes paramètres que les vrais comptes et ne se laisse pas deviner', async () => {
    const leurre = await empreinteLeurre(LEGER);
    expect(leurre.startsWith('scrypt$1024$8$1$')).toBe(true);
    expect(await empreinteLeurre(LEGER)).toBe(leurre); // calculée une seule fois
    expect(await verifier('correct-cheval-pile-agrafe', leurre)).toBe(false);
  });
});
