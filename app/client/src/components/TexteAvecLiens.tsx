import { decouperLiens } from '../lib/liens-texte';

/** Texte libre dont les adresses http(s) deviennent des liens. Rendu en nœuds React : le texte reste du texte, jamais du HTML. */
export function TexteAvecLiens({ texte }: { texte: string }) {
  return (
    <>
      {decouperLiens(texte).map((m, i) =>
        m.type === 'lien' ? (
          <a key={i} href={m.href} target="_blank" rel="noopener noreferrer">
            {m.texte}
          </a>
        ) : (
          m.texte
        ),
      )}
    </>
  );
}
