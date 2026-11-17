import { useEffect, useState } from 'react';
import { listerFils, type Fil as FilType } from '../api/fils';
import { EnteteGroupe } from '../components/EnteteGroupe';
import { Erreur, messageDe } from '../components/Erreur';
import { FilDiscussion } from '../components/FilDiscussion';
import { t } from '../i18n';

/** Page dédiée à un fil de discussion libre. */
export function Fil({ groupId, filId }: { groupId: string; filId: string }) {
  const [fil, setFil] = useState<FilType | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);

  useEffect(() => {
    setErreur(null);
    listerFils(groupId)
      .then((liste) => {
        const trouve = liste.find((f) => f.id === filId);
        setFil(trouve ?? null);
      })
      .catch((err: unknown) => setErreur(messageDe(err)));
  }, [groupId, filId]);

  const titre = fil === null ? t('fil.titre_defaut') : (fil.title ?? fil.event_title ?? t('fil.titre_defaut'));
  const retour = `#/groupe/${encodeURIComponent(groupId)}/fils`;

  return (
    <section className="page-groupe-pile">
      <EnteteGroupe
        groupId={groupId}
        ongletActif="fils"
        titre={titre}
        lienRetour={{ href: retour, libelle: t('fil.retour_fils') }}
      />
      <Erreur message={erreur} />
      <div className="carte">
        <FilDiscussion groupId={groupId} filId={filId} />
      </div>
    </section>
  );
}
