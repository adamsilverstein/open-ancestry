import { createContext, useContext } from 'react';

export interface PaletteControls {
  /** Opens the command palette (people search and actions). */
  open: () => void;
}

export const PaletteContext = createContext<PaletteControls>({ open: () => {} });

/** For "Find" buttons outside the top bar, such as the tree toolbar's Find in tree. */
export function usePalette(): PaletteControls {
  return useContext(PaletteContext);
}
