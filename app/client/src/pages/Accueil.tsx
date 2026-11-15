import { useEffect, useState } from 'react';
import { lireSante, type Sante } from '../api/sante';
import { t } from '../i18n';

type Etat = { type: 'chargement' } | { type: 'ok'; sante: Sante } | { type: 'erreur' };

export function Accueil() {
  const [etat, setEtat] = useState<Etat>({ type: 'chargement' });

  useEffect(() => {
    const controle = new AbortController();
    lireSante(controle.signal)
      .then((sante) => setEtat({ type: 'ok', sante }))
      .catch((erreur: unknown) => {
        if (controle.signal.aborted) return;
        console.error(erreur);
        setEtat({ type: 'erreur' });
      });
    return () => controle.abort();
  }, []);

  return (
    <main className="accueil">
      <h1>{t('app.nom')}</h1>
      <p>{t('app.accroche')}</p>
      <section aria-live="polite">
        <h2>{t('sante.titre')}</h2>
        {etat.type === 'chargement' && <p>{t('sante.chargement')}</p>}
        {etat.type === 'erreur' && <p role="alert">{t('sante.erreur')}</p>}
        {etat.type === 'ok' && (
          <>
            <p>{t('sante.ok')}</p>
            <p>{t('sante.version', { version: etat.sante.version })}</p>
          </>
        )}
      </section>
    </main>
  );
}
