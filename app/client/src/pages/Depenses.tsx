import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  cloturerEvenement,
  confirmerRemboursement,
  creerDepense,
  creerRemboursement,
  lireSoldes,
  listerDepenses,
  listerDevises,
  listerRemboursements,
  reouvrirEvenement,
  supprimerDepense,
  type Depense,
  type Devise,
  type ModeRepartition,
  type Remboursement,
  type ResultatSoldes,
} from '../api/depenses';
import { lireGroupe, listerMembres, type DetailGroupe, type Membre } from '../api/groupes';
import { EnteteGroupe } from '../components/EnteteGroupe';
import { Erreur, messageDe } from '../components/Erreur';
import { IconeBalance, IconePoubelle, IconeRecu } from '../components/Icones';
import { t } from '../i18n';

function formaterMontant(minor: number, code: string, devises: readonly Devise[]): string {
  const exposant = devises.find((d) => d.code === code)?.exponent ?? 2;
  return new Intl.NumberFormat('fr-FR', {
    style: 'currency',
    currency: code,
    minimumFractionDigits: exposant,
    maximumFractionDigits: exposant,
  }).format(minor / 10 ** exposant);
}

/**
 * Lit un montant saisi en unités majeures et le rend en unités mineures, ou `null` s'il est invalide.
 * Seul le bruit de saisie est toléré avant l'analyse : espaces (ordinaires, insécables U+00A0, fines
 * insécables U+202F) et symbole de devise. Le nombre lui-même reste strict (décimales limitées à l'exposant).
 */
function analyserMontant(saisie: string, exposant: number, autoriserZero = false): number | null {
  const texte = saisie.replace(/[\s\u00A0\u202F]/g, '').replace(/\p{Sc}/gu, '');
  if (texte === '') return null;
  if (exposant === 0) {
    if (!/^\d+$/.test(texte)) return null;
    const v = BigInt(texte);
    if ((!autoriserZero && v <= 0n) || v > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return Number(v);
  }
  const m = texte.match(/^(\d+)(?:[,.](\d+))?$/);
  if (!m) return null;
  const entiere = m[1] ?? '';
  const decimale = m[2] ?? '';
  if (decimale.length > exposant) return null;
  const v = BigInt(entiere) * 10n ** BigInt(exposant) + BigInt(decimale.padEnd(exposant, '0'));
  if ((!autoriserZero && v <= 0n) || v > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(v);
}

/**
 * Date du jour dans le fuseau local, au format AAAA-MM-JJ. `toISOString()` serait piégeux ici : il convertit
 * en UTC, donc entre minuit et 1 h ou 2 h à Paris il rend encore la date de la veille.
 */
function aujourdhuiIso(): string {
  const maintenant = new Date();
  const mois = String(maintenant.getMonth() + 1).padStart(2, '0');
  const jour = String(maintenant.getDate()).padStart(2, '0');
  return `${String(maintenant.getFullYear())}-${mois}-${jour}`;
}

/** Date AAAA-MM-JJ (sans heure) lisible, lue en UTC pour ne jamais glisser d'un jour selon le fuseau. */
function formaterDateJour(jour: string): string {
  const date = new Date(`${jour}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return jour;
  return new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(date);
}

export interface PropsSectionDepenses {
  readonly groupId: string;
  readonly evenementId?: string;
  readonly peutCloturer?: boolean;
  readonly deviseCibleDefaut?: string;
  readonly membresFournis?: readonly Membre[];
}

/**
 * Bloc complet des dépenses, soldes, règlements et (si rattaché à un événement) clôture.
 * Utilisé à la fois par la page `#/groupe/:id/depenses` et dans le détail d'un événement.
 */
export function SectionDepenses({
  groupId,
  evenementId,
  peutCloturer = false,
  deviseCibleDefaut,
  membresFournis,
}: PropsSectionDepenses) {
  const [groupe, setGroupe] = useState<DetailGroupe | null>(null);
  const [membres, setMembres] = useState<Membre[]>([]);
  const [devises, setDevises] = useState<Devise[]>([]);
  const [depenses, setDepenses] = useState<Depense[]>([]);
  const [remboursements, setRemboursements] = useState<Remboursement[]>([]);
  const [soldes, setSoldes] = useState<ResultatSoldes | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);

  const [formDepenseOuvert, setFormDepenseOuvert] = useState(false);
  const [formRembOuvert, setFormRembOuvert] = useState(false);

  // Formulaire de nouvelle dépense
  const [libelle, setLibelle] = useState('');
  const [dateDepense, setDateDepense] = useState(aujourdhuiIso);
  const [montantSaisi, setMontantSaisi] = useState('');
  // `null` tant que l'utilisateur n'a rien choisi : la devise effective suit alors celle du groupe.
  const [deviseChoisie, setDeviseChoisie] = useState<string | null>(null);
  const [tauxSaisi, setTauxSaisi] = useState('1');
  const [payeurId, setPayeurId] = useState('');
  const [mode, setMode] = useState<ModeRepartition>('equal');
  const [participantsCoches, setParticipantsCoches] = useState<Record<string, boolean>>({});
  const [poidsParMembre, setPoidsParMembre] = useState<Record<string, string>>({});
  const [partsExactesParMembre, setPartsExactesParMembre] = useState<Record<string, string>>({});

  // Formulaire de règlement
  const [deMembreId, setDeMembreId] = useState('');
  const [versMembreId, setVersMembreId] = useState('');
  const [montantRembSaisi, setMontantRembSaisi] = useState('');
  const [deviseRembChoisie, setDeviseRembChoisie] = useState<string | null>(null);
  const [tauxRembSaisi, setTauxRembSaisi] = useState('1');
  const [noteRemb, setNoteRemb] = useState('');

  const charger = useCallback((): void => {
    setErreur(null);
    Promise.all([
      lireGroupe(groupId),
      membresFournis !== undefined ? Promise.resolve([...membresFournis]) : listerMembres(groupId),
      listerDevises(),
      listerDepenses(groupId, evenementId),
      listerRemboursements(groupId, evenementId),
      lireSoldes(groupId, evenementId),
    ])
      .then(([g, m, devs, deps, rembs, slds]) => {
        setGroupe(g);
        setMembres(m);
        setDevises(devs);
        setDepenses(deps);
        setRemboursements(rembs);
        setSoldes(slds);

        setPayeurId((prev) => (prev === '' ? g.mon_appartenance_id : prev));

        const actifs = m.filter((x) => x.status === 'active');
        // Un membre arrivé depuis le dernier chargement est coché par défaut ; les choix déjà faits sont conservés.
        setParticipantsCoches((prev) => {
          const suite: Record<string, boolean> = { ...prev };
          for (const a of actifs) if (!(a.id in suite)) suite[a.id] = true;
          return suite;
        });
        setDeMembreId((prev) => (prev === '' ? g.mon_appartenance_id : prev));
        setVersMembreId((prev) => {
          if (prev !== '') return prev;
          const autre = actifs.find((a) => a.id !== g.mon_appartenance_id);
          return autre?.id ?? '';
        });
      })
      .catch((err: unknown) => setErreur(messageDe(err)));
  }, [groupId, evenementId, deviseCibleDefaut, membresFournis]);

  useEffect(charger, [charger]);

  // Trois états : erreur (rien à afficher), chargement, prêt.
  if (groupe === null || soldes === null) {
    if (erreur !== null) return <Erreur message={erreur} onReessayer={charger} />;
    return (
      <p role="status" className="discret">
        {t('commun.chargement')}
      </p>
    );
  }

  const deviseCible = deviseCibleDefaut ?? groupe.default_currency_code;
  const deviseCode = deviseChoisie ?? deviseCible;
  const deviseRembCode = deviseRembChoisie ?? deviseCible;
  const estCloture = soldes.cloture !== null;
  const actifs = membres.filter((m) => m.status === 'active');
  const nomDe = (id: string): string => membres.find((m) => m.id === id)?.display_name ?? t('groupe.ancien_membre');

  const soumettreDepense = (e: FormEvent): void => {
    e.preventDefault();
    setErreur(null);
    const exposant = devises.find((d) => d.code === deviseCode)?.exponent ?? 2;
    const minor = analyserMontant(montantSaisi, exposant);
    if (minor === null) {
      setErreur(t('erreur.requete.invalide'));
      return;
    }

    let ratePpm: number | undefined;
    if (deviseCode !== deviseCible) {
      const ppm = analyserMontant(tauxSaisi, 6);
      if (ppm === null) {
        setErreur(t('erreur.taux.requis'));
        return;
      }
      ratePpm = ppm;
    }

    const selectionnes = actifs.filter((m) => participantsCoches[m.id] === true);
    if (selectionnes.length === 0) {
      setErreur(t('erreur.requete.invalide'));
      return;
    }

    const shares: Array<Parameters<typeof creerDepense>[1]['shares'][number]> = [];
    for (const m of selectionnes) {
      if (mode === 'weights') {
        const w = Number(poidsParMembre[m.id] ?? '1');
        if (!Number.isInteger(w) || w <= 0) {
          setErreur(t('erreur.depenses.poids_invalide'));
          return;
        }
        shares.push({ membership_id: m.id, weight: w });
      } else if (mode === 'exact') {
        const part = analyserMontant(partsExactesParMembre[m.id] ?? '0', exposant, true);
        if (part === null) {
          setErreur(t('erreur.requete.invalide'));
          return;
        }
        shares.push({ membership_id: m.id, share_minor: part });
      } else {
        shares.push({ membership_id: m.id });
      }
    }

    creerDepense(groupId, {
      event_id: evenementId ?? null,
      label: libelle.trim(),
      spent_on: dateDepense,
      payer_membership_id: payeurId,
      amount_minor: minor,
      currency_code: deviseCode,
      ...(ratePpm !== undefined ? { rate_ppm: ratePpm } : {}),
      split_mode: mode,
      shares,
    })
      .then(() => {
        setLibelle('');
        setMontantSaisi('');
        setFormDepenseOuvert(false);
        charger();
      })
      .catch((err: unknown) => setErreur(messageDe(err)));
  };

  const soumettreRemboursement = (e: FormEvent): void => {
    e.preventDefault();
    setErreur(null);
    const exposant = devises.find((d) => d.code === deviseRembCode)?.exponent ?? 2;
    const minor = analyserMontant(montantRembSaisi, exposant);
    if (minor === null || deMembreId === '' || versMembreId === '' || deMembreId === versMembreId) {
      setErreur(t('erreur.requete.invalide'));
      return;
    }

    let ratePpm: number | undefined;
    if (deviseRembCode !== deviseCible) {
      const ppm = analyserMontant(tauxRembSaisi, 6);
      if (ppm === null) {
        setErreur(t('erreur.taux.requis'));
        return;
      }
      ratePpm = ppm;
    }

    creerRemboursement(groupId, {
      event_id: evenementId ?? null,
      from_membership_id: deMembreId,
      to_membership_id: versMembreId,
      amount_minor: minor,
      currency_code: deviseRembCode,
      ...(ratePpm !== undefined ? { rate_ppm: ratePpm } : {}),
      settled_on: aujourdhuiIso(),
      method_note: noteRemb.trim() === '' ? null : noteRemb.trim(),
    })
      .then(() => {
        setMontantRembSaisi('');
        setNoteRemb('');
        setFormRembOuvert(false);
        charger();
      })
      .catch((err: unknown) => setErreur(messageDe(err)));
  };

  return (
    <div className="page-groupe-pile">
      <Erreur message={erreur} />

      {evenementId !== undefined && (estCloture || peutCloturer) && (
        <div className="carte barre">
          {estCloture ? (
            <>
              <span role="status" className="pilule pilule-statut-maybe">
                {t('depenses.cloture_active')}
              </span>
              {peutCloturer && (
                <button
                  type="button"
                  className="bouton-compact"
                  onClick={() =>
                    reouvrirEvenement(groupId, evenementId)
                      .then(charger)
                      .catch((err: unknown) => setErreur(messageDe(err)))
                  }
                >
                  {t('depenses.reouvrir')}
                </button>
              )}
            </>
          ) : (
            peutCloturer && (
              <button
                type="button"
                className="bouton-compact"
                onClick={() =>
                  cloturerEvenement(groupId, evenementId)
                    .then(charger)
                    .catch((err: unknown) => setErreur(messageDe(err)))
                }
              >
                {t('depenses.cloturer')}
              </button>
            )
          )}
        </div>
      )}

      <div className="carte">
        <div className="carte-entete">
          <h3 className="widget-titre">
            <IconeBalance className="widget-titre-icone icone-emeraude" />
            <span>{t('depenses.soldes_titre')}</span>
          </h3>
          {!estCloture && (
            <div className="barre-compacte">
              <button
                type="button"
                className={formDepenseOuvert ? 'bouton-compact' : 'bouton-primaire bouton-compact'}
                onClick={() => {
                  setFormDepenseOuvert(!formDepenseOuvert);
                  if (!formDepenseOuvert) setFormRembOuvert(false);
                }}
              >
                {t(formDepenseOuvert ? 'depenses.fermer_formulaire' : 'depenses.ajouter_bouton')}
              </button>
              {actifs.length >= 2 && (
                <button
                  type="button"
                  className="bouton-compact"
                  onClick={() => {
                    setFormRembOuvert(!formRembOuvert);
                    if (!formRembOuvert) setFormDepenseOuvert(false);
                  }}
                >
                  {t(formRembOuvert ? 'depenses.fermer_formulaire' : 'depenses.declarer_bouton')}
                </button>
              )}
            </div>
          )}
        </div>

        {soldes.ardoises.length === 0 ? (
          <p className="discret">{t('depenses.aucun_solde')}</p>
        ) : (
          <div className="grille-soldes-ardoises">
            {soldes.ardoises.map((ardoise) => (
              <div key={ardoise.currency_code} className="grille-soldes-resume">
                <div className="bloc-resume-soldes">
                  <h4 className="sous-titre-compact">{ardoise.currency_code}</h4>
                  <div className="soldes-pilules">
                    {ardoise.soldes.map((s) => {
                      const classe =
                        s.net_minor > 0 ? 'pilule-positif' : s.net_minor < 0 ? 'pilule-negatif' : 'pilule-neutre';
                      return (
                        <span key={s.membership_id} className={`pilule-solde ${classe}`}>
                          <span>{nomDe(s.membership_id)}</span>
                          <strong>{formaterMontant(s.net_minor, ardoise.currency_code, devises)}</strong>
                        </span>
                      );
                    })}
                  </div>
                </div>
                {ardoise.transferts.length > 0 && (
                  <div className="bloc-resume-suggestions">
                    <h4 className="sous-titre-compact">{t('depenses.suggestions_titre')}</h4>
                    <ul className="liste-elements">
                      {ardoise.transferts.map((tr, idx) => (
                        <li
                          key={`${tr.from_membership_id}-${tr.to_membership_id}-${String(idx)}`}
                          className="ligne ligne-compacte"
                        >
                          <span>
                            {t('depenses.suggestion_ligne', {
                              de: nomDe(tr.from_membership_id),
                              vers: nomDe(tr.to_membership_id),
                              montant: formaterMontant(tr.amount_minor, tr.currency_code, devises),
                            })}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {!estCloture && formDepenseOuvert && (
        <div className="carte">
          <div className="carte-entete">
            <h3>{t('depenses.ajouter_titre')}</h3>
          </div>
          <form onSubmit={soumettreDepense} className="formulaire">
            <label>
              {t('depenses.champ_libelle')}
              <input type="text" value={libelle} maxLength={140} onChange={(e) => setLibelle(e.target.value)} required />
            </label>
            <div className="grille-champs-2">
              <label>
                {t('depenses.champ_montant')}
                <input
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  value={montantSaisi}
                  onChange={(e) => setMontantSaisi(e.target.value)}
                  placeholder={t('depenses.exemple_montant')}
                  aria-describedby="aide-montant-depense"
                  required
                />
                {/* La contrainte est dite avant l'erreur : le `placeholder` seul ne suffit pas,
                    il disparaît dès la première frappe. */}
                <small id="aide-montant-depense" className="texte-doux">
                  {t('depenses.aide_montant')}
                </small>
              </label>
              <label>
                {t('depenses.champ_devise')}
                <select value={deviseCode} onChange={(e) => setDeviseChoisie(e.target.value)}>
                  {devises.map((d) => (
                    <option key={d.code} value={d.code}>
                      {t('depenses.option_devise', { code: d.code, symbole: d.symbol })}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {deviseCode !== deviseCible && (
              <label>
                {t('depenses.champ_taux', { source: deviseCode, cible: deviseCible })}
                <input
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  value={tauxSaisi}
                  onChange={(e) => setTauxSaisi(e.target.value)}
                  placeholder={t('depenses.exemple_montant')}
                  required
                />
              </label>
            )}
            <div className="grille-champs-2">
              <label>
                {t('depenses.champ_date')}
                <input type="date" value={dateDepense} onChange={(e) => setDateDepense(e.target.value)} required />
              </label>
              <label>
                {t('depenses.champ_payeur')}
                <select value={payeurId} onChange={(e) => setPayeurId(e.target.value)}>
                  {actifs.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.display_name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label>
              {t('depenses.champ_mode')}
              <select value={mode} onChange={(e) => setMode(e.target.value as ModeRepartition)}>
                <option value="equal">{t('depenses.mode_equal')}</option>
                <option value="weights">{t('depenses.mode_weights')}</option>
                <option value="exact">{t('depenses.mode_exact')}</option>
              </select>
            </label>
            <fieldset className="champ-participants">
              <legend>{t('depenses.champ_participants')}</legend>
              {actifs.map((m) => (
                <div key={m.id} className="barre">
                  <label className="ligne-case">
                    <input
                      type="checkbox"
                      checked={participantsCoches[m.id] === true}
                      onChange={(e) => setParticipantsCoches((p) => ({ ...p, [m.id]: e.target.checked }))}
                    />
                    {m.display_name}
                  </label>
                  {participantsCoches[m.id] === true && mode === 'weights' && (
                    <input
                      type="number"
                      min={1}
                      value={poidsParMembre[m.id] ?? '1'}
                      onChange={(e) => setPoidsParMembre((p) => ({ ...p, [m.id]: e.target.value }))}
                    />
                  )}
                  {participantsCoches[m.id] === true && mode === 'exact' && (
                    <input
                      type="text"
                      inputMode="decimal"
                      autoComplete="off"
                      aria-label={`${t('depenses.champ_mode')} ${m.display_name}`}
                      placeholder={t('depenses.exemple_part')}
                      value={partsExactesParMembre[m.id] ?? ''}
                      onChange={(e) => setPartsExactesParMembre((p) => ({ ...p, [m.id]: e.target.value }))}
                    />
                  )}
                </div>
              ))}
            </fieldset>
            <button type="submit">{t('depenses.ajouter')}</button>
          </form>
        </div>
      )}

      {!estCloture && formRembOuvert && actifs.length >= 2 && (
        <div className="carte">
          <div className="carte-entete">
            <h3>{t('depenses.declarer_remboursement')}</h3>
          </div>
          <form onSubmit={soumettreRemboursement} className="formulaire">
            <div className="grille-champs-2">
              <label>
                {t('depenses.champ_de')}
                <select value={deMembreId} onChange={(e) => setDeMembreId(e.target.value)}>
                  {actifs.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.display_name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t('depenses.champ_vers')}
                <select value={versMembreId} onChange={(e) => setVersMembreId(e.target.value)}>
                  {actifs.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.display_name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="grille-champs-2">
              <label>
                {t('depenses.champ_montant')}
                <input
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  value={montantRembSaisi}
                  onChange={(e) => setMontantRembSaisi(e.target.value)}
                  placeholder={t('depenses.exemple_montant')}
                  required
                />
              </label>
              <label>
                {t('depenses.champ_devise')}
                <select value={deviseRembCode} onChange={(e) => setDeviseRembChoisie(e.target.value)}>
                  {devises.map((d) => (
                    <option key={d.code} value={d.code}>
                      {t('depenses.option_devise', { code: d.code, symbole: d.symbol })}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {deviseRembCode !== deviseCible && (
              <label>
                {t('depenses.champ_taux', { source: deviseRembCode, cible: deviseCible })}
                <input
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  value={tauxRembSaisi}
                  onChange={(e) => setTauxRembSaisi(e.target.value)}
                  placeholder={t('depenses.exemple_montant')}
                  required
                />
              </label>
            )}
            <label>
              {t('depenses.champ_note_hors_app')}
              <input type="text" maxLength={200} value={noteRemb} onChange={(e) => setNoteRemb(e.target.value)} />
            </label>
            <button type="submit">{t('depenses.enregistrer_remboursement')}</button>
          </form>
        </div>
      )}

      <div className="carte">
        <div className="carte-entete">
          <h3 className="widget-titre">
            <IconeRecu className="widget-titre-icone icone-rose" />
            <span>{t('depenses.liste_titre')}</span>
          </h3>
        </div>
        {depenses.length === 0 ? (
          <p className="discret">{t('depenses.aucune')}</p>
        ) : (
          <ul className="liste-elements">
            {depenses.map((d) => {
              const peutSupprimer =
                !estCloture &&
                (d.created_by_membership_id === groupe.mon_appartenance_id ||
                  d.payer_membership_id === groupe.mon_appartenance_id ||
                  groupe.mon_role === 'admin');
              return (
                <li key={d.id} className="ligne ligne-depense">
                  <span className="depense-icone-rond" aria-hidden="true">
                    <IconeRecu className="icone-mini" />
                  </span>
                  <div className="ligne-principale">
                    <span className="ligne-titre">{d.label}</span>
                    <span className="ligne-meta">
                      {t('depenses.paye_par_date', { nom: nomDe(d.payer_membership_id), date: formaterDateJour(d.spent_on) })}
                    </span>
                  </div>
                  <div className="ligne-depense-droite">
                    <div className="montant-depense-pile">
                      <span className="montant-depense">{formaterMontant(d.amount_minor, d.currency_code, devises)}</span>
                      {d.currency_code !== d.target_currency_code && (
                        <span className="ligne-meta">
                          {t('depenses.converti_info', {
                            montant_cible: formaterMontant(d.amount_target_minor, d.target_currency_code, devises),
                          })}
                        </span>
                      )}
                    </div>
                    {peutSupprimer && (
                      <button
                        type="button"
                        className="bouton-icone-discret"
                        aria-label={`${t('depenses.supprimer')} ${d.label}`}
                        onClick={() =>
                          supprimerDepense(groupId, d.id)
                            .then(charger)
                            .catch((err: unknown) => setErreur(messageDe(err)))
                        }
                      >
                        <IconePoubelle className="icone-mini" />
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {remboursements.length > 0 && (
        <div className="carte">
          <div className="carte-entete">
            <h3>{t('depenses.reglements_titre')}</h3>
          </div>
          <ul className="liste-elements">
            {remboursements.map((r) => {
              const confirme = r.confirmed_by_membership_id !== null;
              const statut = t(confirme ? 'depenses.statut_confirme' : 'depenses.statut_en_attente');
              const montant = formaterMontant(r.amount_minor, r.currency_code, devises);
              return (
                <li key={r.id} className="ligne">
                  <div className="ligne-principale">
                    <span className="ligne-titre">
                      {r.method_note !== null
                        ? t('depenses.remboursement_ligne_note', {
                            de: nomDe(r.from_membership_id),
                            vers: nomDe(r.to_membership_id),
                            montant,
                            statut,
                            note: r.method_note,
                          })
                        : t('depenses.remboursement_ligne', {
                            de: nomDe(r.from_membership_id),
                            vers: nomDe(r.to_membership_id),
                            montant,
                            statut,
                          })}
                    </span>
                  </div>
                  <div className="ligne-actions-discretes">
                    <span className={`pilule${confirme ? ' pilule-statut-yes' : ' pilule-statut-maybe'}`}>{statut}</span>
                    {!estCloture && !confirme && r.to_membership_id === groupe.mon_appartenance_id && (
                      <button
                        type="button"
                        className="bouton-compact"
                        aria-label={`${t('depenses.confirmer')} ${nomDe(r.from_membership_id)} → ${nomDe(r.to_membership_id)}`}
                        onClick={() =>
                          confirmerRemboursement(groupId, r.id)
                            .then(charger)
                            .catch((err: unknown) => setErreur(messageDe(err)))
                        }
                      >
                        {t('depenses.confirmer')}
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Page `#/groupe/:id/depenses` : dépenses, soldes et règlements du groupe. */
export function Depenses({ groupId }: { groupId: string }) {
  return (
    <section className="page-groupe-pile">
      <EnteteGroupe groupId={groupId} ongletActif="depenses" titre={t('depenses.titre')} />
      <SectionDepenses groupId={groupId} />
    </section>
  );
}
