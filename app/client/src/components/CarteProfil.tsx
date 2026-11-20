import { useId, useState, type FormEvent } from 'react';
import { modifierProfil, renvoyerVerificationEmail } from '../api/compte';
import type { Moi } from '../api/groupes';
import { ErreurApi } from '../api/client';
import { Erreur, messageDe } from '../components/Erreur';
import { useSoumission } from '../hooks/useSoumission';
import { t } from '../i18n';

/**
 * Fuseaux proposés dans la liste de saisie. `Intl.supportedValuesOf` manque aux navigateurs les plus anciens :
 * on renvoie alors `null` et le champ reste une saisie libre, que le serveur valide de toute façon.
 */
function fuseauxConnus(): readonly string[] | null {
  const intl: { supportedValuesOf?: (cle: 'timeZone') => string[] } = Intl;
  if (typeof intl.supportedValuesOf !== 'function') return null;
  try {
    return intl.supportedValuesOf('timeZone');
  } catch {
    // Clé refusée par un moteur partiel : même repli que si la méthode n'existait pas.
    return null;
  }
}

/** Même test que le serveur (`fuseauValide`) : un fuseau inconnu fait lever `Intl.DateTimeFormat`. */
function fuseauValide(valeur: string): boolean {
  if (valeur === '') return false;
  try {
    new Intl.DateTimeFormat('fr', { timeZone: valeur });
    return true;
  } catch {
    return false;
  }
}

/** Mon profil : nom affiché, fuseau horaire, et rappel d'une adresse e-mail non confirmée. */
export function CarteProfil({ moi, onProfilChange }: { moi: Moi; onProfilChange?: (() => void) | undefined }) {
  const [nom, setNom] = useState(moi.display_name);
  const [fuseau, setFuseau] = useState(moi.time_zone);
  const [erreurNom, setErreurNom] = useState(false);
  const [erreurFuseau, setErreurFuseau] = useState(false);
  const [info, setInfo] = useState<string | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [infoEmail, setInfoEmail] = useState<string | null>(null);
  const [erreurEmail, setErreurEmail] = useState<string | null>(null);
  const enregistrement = useSoumission();
  const renvoi = useSoumission();
  const idNom = useId();
  const idErreurNom = useId();
  const idFuseau = useId();
  const idListe = useId();
  const idAideFuseau = useId();
  const idErreurFuseau = useId();

  // Calculée à chaque rendu : l'appel est peu coûteux et le résultat ne change pas, mais on le garde hors d'un état.
  const fuseaux = fuseauxConnus();
  // Le fuseau du compte peut être absent de la liste du navigateur (« UTC ») : on l'y ajoute pour qu'il reste proposé.
  const options = fuseaux === null || fuseaux.includes(moi.time_zone) ? fuseaux : [moi.time_zone, ...fuseaux];

  const nomPropre = nom.trim();
  const fuseauPropre = fuseau.trim();
  const modifie = nomPropre !== moi.display_name || fuseauPropre !== moi.time_zone;

  const enregistrer = (e: FormEvent): void => {
    e.preventDefault();
    setInfo(null);
    setErreur(null);
    const nomVide = nomPropre === '';
    const fuseauInvalide = !fuseauValide(fuseauPropre);
    setErreurNom(nomVide);
    setErreurFuseau(fuseauInvalide);
    if (nomVide || fuseauInvalide) return;
    // Seuls les champs changés partent : le serveur en exige au moins un et ne touche pas aux absents.
    const champs: { display_name?: string; time_zone?: string } = {};
    if (nomPropre !== moi.display_name) champs.display_name = nomPropre;
    if (fuseauPropre !== moi.time_zone) champs.time_zone = fuseauPropre;
    if (Object.keys(champs).length === 0) return;
    enregistrement
      .lancer(() =>
        modifierProfil(champs).then((profil) => {
          setNom(profil.display_name);
          setFuseau(profil.time_zone);
          setInfo(t('profil.enregistre'));
          onProfilChange?.();
        }),
      )
      .catch((err: unknown) => setErreur(messageDe(err)));
  };

  const renvoyer = (): void => {
    setInfoEmail(null);
    setErreurEmail(null);
    renvoi
      .lancer(() => renvoyerVerificationEmail().then(() => setInfoEmail(t('profil.renvoye'))))
      .catch((err: unknown) => {
        // 409 : l'adresse a été confirmée entre-temps (autre onglet, lien ouvert). Le bandeau n'a plus lieu d'être.
        if (err instanceof ErreurApi && err.cle === 'email.deja_verifie') {
          setInfoEmail(t('profil.deja_confirmee'));
          onProfilChange?.();
          return;
        }
        setErreurEmail(messageDe(err));
      });
  };

  return (
    <section className="carte">
      <div className="carte-entete">
        <h3>{t('profil.titre')}</h3>
      </div>
      <p className="texte-doux">{t('profil.description')}</p>

      {moi.email_verified_at === null && (
        <div className="message-avertissement carte-profil-email">
          <p>{t('profil.email_non_confirme')}</p>
          <button type="button" className="bouton bouton-compact" disabled={renvoi.enCours} onClick={renvoyer}>
            {renvoi.enCours ? t('profil.renvoi_en_cours') : t('profil.renvoyer')}
          </button>
          {infoEmail !== null && (
            <p role="status" className="message-succes">
              {infoEmail}
            </p>
          )}
          <Erreur message={erreurEmail} />
        </div>
      )}

      <form onSubmit={enregistrer} className="formulaire" noValidate>
        <label htmlFor={idNom}>{t('profil.champ_nom')}</label>
        <input
          id={idNom}
          type="text"
          value={nom}
          maxLength={60}
          autoComplete="name"
          disabled={enregistrement.enCours}
          aria-invalid={erreurNom}
          {...(erreurNom ? { 'aria-describedby': idErreurNom } : {})}
          onChange={(e) => setNom(e.target.value)}
        />
        {erreurNom && (
          <p id={idErreurNom} className="erreur-champ">
            {t('profil.nom_vide')}
          </p>
        )}

        <label htmlFor={idFuseau}>{t('profil.champ_fuseau')}</label>
        <input
          id={idFuseau}
          type="text"
          value={fuseau}
          maxLength={64}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          disabled={enregistrement.enCours}
          aria-invalid={erreurFuseau}
          aria-describedby={erreurFuseau ? `${idAideFuseau} ${idErreurFuseau}` : idAideFuseau}
          {...(options !== null ? { list: idListe } : {})}
          onChange={(e) => setFuseau(e.target.value)}
        />
        {options !== null && (
          <datalist id={idListe}>
            {options.map((z) => (
              <option key={z} value={z} />
            ))}
          </datalist>
        )}
        <p id={idAideFuseau} className="texte-doux">
          {options !== null ? t('profil.aide_fuseau') : t('profil.aide_fuseau_libre')}
        </p>

        {erreurFuseau && (
          <p id={idErreurFuseau} className="erreur-champ">
            {t('profil.fuseau_invalide')}
          </p>
        )}

        <Erreur message={erreur} />
        {info !== null && (
          <p role="status" className="message-succes">
            {info}
          </p>
        )}
        <div className="barre-compacte">
          <button type="submit" className="bouton bouton-primaire" disabled={enregistrement.enCours || !modifie}>
            {enregistrement.enCours ? t('profil.enregistrement') : t('profil.enregistrer')}
          </button>
        </div>
      </form>
    </section>
  );
}
