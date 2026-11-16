import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  changerRole,
  inviter,
  lireGroupe,
  listerInvitationsEmises,
  listerMembres,
  quitterGroupe,
  retirerMembre,
  revoquerInvitation,
  type DetailGroupe,
  type InvitationEmise,
  type Membre,
} from '../api/groupes';
import { Erreur, messageDe } from '../components/Erreur';
import { t, type CleTexte } from '../i18n';

/** Un groupe : détail, membres, et (administrateur) invitations émises. */
export function Groupe({ groupId, onQuitte }: { groupId: string; onQuitte: () => void }) {
  const [groupe, setGroupe] = useState<DetailGroupe | null>(null);
  const [membres, setMembres] = useState<Membre[]>([]);
  const [invitations, setInvitations] = useState<InvitationEmise[]>([]);
  const [erreur, setErreur] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [mode, setMode] = useState<'email' | 'username'>('email');
  const [cible, setCible] = useState('');

  const charger = useCallback((): void => {
    setErreur(null);
    lireGroupe(groupId)
      .then(async (g) => {
        setGroupe(g);
        setMembres(await listerMembres(groupId));
        setInvitations(g.mon_role === 'admin' ? await listerInvitationsEmises(groupId) : []);
      })
      .catch((err: unknown) => setErreur(messageDe(err)));
  }, [groupId]);
  useEffect(charger, [charger]);

  const agir = (action: Promise<void>, apres: () => void = charger): void => {
    setErreur(null);
    setInfo(null);
    action.then(apres).catch((err: unknown) => setErreur(messageDe(err)));
  };

  const soumettreInvitation = (e: FormEvent): void => {
    e.preventDefault();
    agir(inviter(groupId, mode === 'email' ? { email: cible } : { username: cible }, 'member'), () => {
      setCible('');
      setInfo(t('invitations_emises.envoyee'));
      charger();
    });
  };

  if (groupe === null) return <Erreur message={erreur} />;
  const admin = groupe.mon_role === 'admin';

  return (
    <section>
      <h2>{groupe.name}</h2>
      <p>{t('groupe.devise', { devise: groupe.default_currency_code })}</p>
      <p>{t('groupe.fuseau', { fuseau: groupe.time_zone })}</p>
      <p>{t(admin ? 'groupe.mon_role_admin' : 'groupe.mon_role_member')}</p>
      <p>
        <a href={`#/groupe/${encodeURIComponent(groupId)}/agenda`}>{t('groupe.agenda')}</a>
      </p>
      <p>
        <a href={`#/groupe/${encodeURIComponent(groupId)}/listes`}>{t('groupe.listes')}</a>
      </p>
      <Erreur message={erreur} />

      <h3>{t('membres.titre')}</h3>
      <ul>
        {membres.map((m) => {
          const actif = m.status === 'active';
          return (
            <li key={m.id}>
              {t(actif ? 'membres.ligne' : 'membres.ligne_ancien', { nom: m.display_name, role: t(m.role === 'admin' ? 'membres.role_admin' : 'membres.role_member') })}
              {admin && actif && m.id !== groupe.mon_appartenance_id && (
                <>
                  <button type="button" onClick={() => agir(changerRole(groupId, m.id, m.role === 'admin' ? 'member' : 'admin'))}>
                    {t(m.role === 'admin' ? 'membres.retrograder' : 'membres.promouvoir')}
                  </button>
                  <button type="button" onClick={() => window.confirm(t('membres.retirer_confirmation')) && agir(retirerMembre(groupId, m.id))}>
                    {t('membres.retirer')}
                  </button>
                </>
              )}
            </li>
          );
        })}
      </ul>
      <button type="button" onClick={() => window.confirm(t('groupe.quitter_confirmation')) && agir(quitterGroupe(groupId), onQuitte)}>
        {t('groupe.quitter')}
      </button>

      {admin && (
        <>
          <h3>{t('invitations_emises.titre')}</h3>
          <form onSubmit={soumettreInvitation} className="formulaire">
            <label>
              <input type="radio" name="voie" checked={mode === 'email'} onChange={() => setMode('email')} />
              {t('invitations_emises.par_email')}
            </label>
            <label>
              <input type="radio" name="voie" checked={mode === 'username'} onChange={() => setMode('username')} />
              {t('invitations_emises.par_nom')}
            </label>
            <label>
              {t(mode === 'email' ? 'invitations_emises.cible_email' : 'invitations_emises.cible_nom')}
              <input type={mode === 'email' ? 'email' : 'text'} value={cible} onChange={(e) => setCible(e.target.value)} required />
            </label>
            <button type="submit">{t('invitations_emises.inviter')}</button>
          </form>
          {info !== null && <p role="status">{info}</p>}
          {invitations.length === 0 && <p>{t('invitations_emises.aucune')}</p>}
          <ul>
            {invitations.map((i) => (
              <li key={i.id}>
                {t('invitations_emises.ligne', { cible: i.email ?? i.username ?? '', statut: t(`invitations_emises.statut_${i.status}` as CleTexte) })}
                {i.status === 'pending' && (
                  <button type="button" onClick={() => agir(revoquerInvitation(groupId, i.id))}>
                    {t('invitations_emises.revoquer')}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
