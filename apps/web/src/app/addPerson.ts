import { createContext, useContext } from 'react';

export interface AddPersonControls {
  /** Opens the Add person dialog for the open tree. */
  open: () => void;
}

export const AddPersonContext = createContext<AddPersonControls>({ open: () => {} });

/** For Add person buttons outside the shell: the people list and its empty state. */
export function useAddPerson(): AddPersonControls {
  return useContext(AddPersonContext);
}
