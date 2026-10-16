import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowRight } from 'lucide-react';
import buttonStyles from '../../components/Button/Button.module.css';
import { cx } from '../../lib/cx';
import { personQuery } from '../../api/queries';
import { fullName } from '../../lib/person';
import type { ImportJob, ImportReportView } from '../../library/api';
import styles from './Import.module.css';

/** Rows shown in the tables; the report itself keeps up to 1,000 warnings. */
const MAX_ROWS = 500;

const STATS: [label: string, table: string][] = [
  ['People', 'person'],
  ['Families', 'family'],
  ['Events', 'event'],
  ['Places', 'place'],
  ['Sources', 'source'],
  ['Citations', 'citation'],
  ['Notes', 'note'],
  ['Media', 'media'],
];

const n = (value: number) => value.toLocaleString();
/** Import time: tenths of a second, or "under 0.1 s" rather than "0.0 s". */
const seconds = (ms: number) => (ms < 100 ? 'under 0.1 s' : `${(ms / 1000).toFixed(1)} s`);
/** The format the importer read, with the GEDCOM version it assumed (as the CLI prints it). */
const formatName = (format: string) =>
  format === 'gedzip' ? 'GEDZIP' : `GEDCOM ${format.replace(/^gedcom-/, '')}`;

/** Moves focus to the heading when the report appears, so the outcome is announced. */
const focusOnMount = (element: HTMLElement | null) => element?.focus();

export function ImportReport({
  job,
  report,
  note,
}: {
  job: ImportJob;
  report: ImportReportView;
  /** Shown under the title, announced politely (e.g. a cancel that came too late). */
  note?: string | undefined;
}) {
  const { lines, media, source } = report;
  const home = report.homePersonId;
  const { data: homePerson } = useQuery({
    ...personQuery(job.tree, home ?? ''),
    enabled: home !== null,
  });
  const openClass = cx(buttonStyles.button, buttonStyles.primary, buttonStyles.md);
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title} ref={focusOnMount} tabIndex={-1}>
            Import complete
          </h1>
          <p className={styles.subtitle}>
            {job.fileName} into “{job.tree}” in {seconds(report.timings.total)}
          </p>
          {note && (
            <p role="status" className={styles.note}>
              {note}
            </p>
          )}
        </div>
        {home ? (
          <Link to="/tree/$personId" params={{ personId: home }} className={openClass}>
            Open tree
            <ArrowRight size={16} aria-hidden />
          </Link>
        ) : (
          <Link to="/" className={openClass}>
            Open tree
            <ArrowRight size={16} aria-hidden />
          </Link>
        )}
      </header>

      <section aria-label="Import report" className={styles.section}>
        <div className={styles.stats}>
          {[
            ...STATS.map(([label, table]) => [label, report.rows[table] ?? 0] as const),
            ['Repositories', report.rows.repository ?? 0] as const,
            // Submitters are kept whole with the header, so count the records.
            ['Submitters', report.records.SUBM ?? 0] as const,
          ].map(([label, count]) => (
            <div key={label} role="group" aria-label={label} className={styles.stat}>
              <span className={styles.statValue}>{n(count)}</span>
              <span className={styles.statLabel}>{label}</span>
            </div>
          ))}
        </div>
        <dl className={styles.facts}>
          <dt>Exported by</dt>
          <dd>{[source.system, source.version].filter(Boolean).join(' ') || 'Unknown'}</dd>
          <dt>Format</dt>
          <dd>
            {formatName(report.format)}, {report.encoding}
          </dd>
          <dt>Lines</dt>
          <dd>
            {n(lines.total)} lines: {n(lines.mapped)} mapped, {n(lines.preserved)} kept verbatim.{' '}
            {report.unmapped.length > 0
              ? 'Lines that could not be mapped are kept verbatim and listed below.'
              : lines.preserved > 0
                ? `Every line was mapped except the ${n(lines.preserved)} header ${lines.preserved === 1 ? 'line, which is' : 'lines, which are'} kept verbatim for export.`
                : 'Every line was mapped.'}
          </dd>
          <dt>Home person</dt>
          <dd>
            {home ? (
              <Link to="/person/$personId" params={{ personId: home }}>
                {homePerson ? fullName(homePerson.summary) : 'Home person'}
              </Link>
            ) : (
              'None set'
            )}
          </dd>
          <dt>Living</dt>
          <dd>
            {n(report.living.living)} living, {n(report.living.deceased)} deceased
          </dd>
          <dt>Media files</dt>
          <dd>
            {n(media.linked)} copied, {n(media.remote)} online only (not downloaded),{' '}
            {n(media.missing.length)} missing
            {media.rejected > 0 && `, ${n(media.rejected)} refused (unsafe path)`}
          </dd>
        </dl>
      </section>

      <section aria-label="Warnings" className={styles.section}>
        <h2 className={styles.sectionTitle}>Warnings ({n(report.warningCount)})</h2>
        {report.warningCount === 0 ? (
          <p className={styles.note}>No warnings</p>
        ) : (
          <>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th scope="col">Line</th>
                    <th scope="col">Kind</th>
                    <th scope="col">Message</th>
                  </tr>
                </thead>
                <tbody>
                  {report.warnings.slice(0, MAX_ROWS).map((w, i) => (
                    <tr key={i}>
                      <td>{w.line > 0 ? `Line ${w.line}` : 'File'}</td>
                      <td className={styles.mono}>{w.code}</td>
                      <td>{w.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {report.warningCount > Math.min(report.warnings.length, MAX_ROWS) && (
              <p className={styles.note}>
                Showing {n(Math.min(report.warnings.length, MAX_ROWS))} of {n(report.warningCount)}{' '}
                warnings.
              </p>
            )}
          </>
        )}
      </section>

      <section aria-label="Unmapped tags" className={styles.section}>
        <h2 className={styles.sectionTitle}>Unmapped tags ({n(report.unmapped.length)})</h2>
        {report.unmapped.length === 0 ? (
          <p className={styles.note}>No unmapped tags</p>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Tag path</th>
                  <th scope="col">Lines</th>
                  <th scope="col">Example</th>
                </tr>
              </thead>
              <tbody>
                {report.unmapped.slice(0, MAX_ROWS).map((u) => (
                  <tr key={u.path}>
                    <td className={styles.mono}>{u.path}</td>
                    <td>{n(u.count)}</td>
                    <td className={styles.mono}>
                      Line {u.example.line}: {u.example.text}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {media.missing.length > 0 && (
        <section aria-label="Missing media" className={styles.section}>
          <h2 className={styles.sectionTitle}>Missing media ({n(media.missing.length)})</h2>
          <ul className={styles.note}>
            {media.missing.slice(0, MAX_ROWS).map((m) => (
              <li key={`${m.line}`} className={styles.mono}>
                Line {m.line}: {m.path}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
