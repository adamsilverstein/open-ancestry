import { useState } from 'react';
import type { Sex } from '@open-ancestry/db';
import { DateInput } from '../../../components/DateInput/DateInput';
import { Input } from '../../../components/Input/Input';
import { Select } from '../../../components/Select/Select';
import { SEX_OPTIONS } from './EditPersonDialog';
import styles from './Edit.module.css';

/** The fields of a new person, shared by Add person and Add family member. */
export function useNewPerson() {
  const [given, setGiven] = useState('');
  const [surname, setSurname] = useState('');
  const [sex, setSex] = useState<Sex>('U');
  const [birth, setBirth] = useState('');
  return {
    given,
    setGiven,
    surname,
    setSurname,
    sex,
    setSex,
    birth,
    setBirth,
    /** A person needs at least one name part. */
    ready: given.trim() !== '' || surname.trim() !== '',
    /** Body for `POST /people` and the `person` of a relative. */
    body: () => ({
      sex,
      names: [{ given: given.trim() || null, surname: surname.trim() || null }],
      events: birth.trim() ? [{ type: 'BIRT', date_text: birth.trim() }] : [],
    }),
  };
}

export type NewPerson = ReturnType<typeof useNewPerson>;

export function NewPersonFields({ draft }: { draft: NewPerson }) {
  return (
    <div className={styles.grid}>
      <Input
        label="Given names"
        value={draft.given}
        onChange={(e) => draft.setGiven(e.currentTarget.value)}
      />
      <Input
        label="Surname"
        value={draft.surname}
        onChange={(e) => draft.setSurname(e.currentTarget.value)}
      />
      <Select
        label="Sex"
        value={draft.sex}
        onValueChange={(value) => draft.setSex(value as Sex)}
        options={SEX_OPTIONS}
      />
      <DateInput label="Birth date" value={draft.birth} onValueChange={draft.setBirth} hint="" />
    </div>
  );
}
