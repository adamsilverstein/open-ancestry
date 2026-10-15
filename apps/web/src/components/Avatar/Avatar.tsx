import { useState } from 'react';
import { UserRound } from 'lucide-react';
import { cx } from '../../lib/cx';
import { initials, sexLabel, type Sex } from '../../lib/person';
import styles from './Avatar.module.css';

export type AvatarSize = 24 | 40 | 64 | 120;

export interface AvatarProps {
  name: string;
  sex?: Sex;
  /** Photo URL; falls back when missing or when it fails to load. */
  src?: string | undefined;
  size?: AvatarSize;
  /** Fallback when there is no photo. */
  fallback?: 'silhouette' | 'initials';
  /** Hide from assistive tech when the name is already announced nearby. */
  decorative?: boolean;
  className?: string;
  'data-testid'?: string;
}

export function Avatar({
  name,
  sex = 'U',
  src,
  size = 40,
  fallback = 'silhouette',
  decorative = false,
  className,
  'data-testid': testId,
}: AvatarProps) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const showPhoto = src && failedSrc !== src;
  const classes = cx(styles.avatar, styles[`sex${sex}`], className);
  const style = { width: size, height: size };

  if (showPhoto) {
    return (
      <img
        className={classes}
        style={style}
        src={src}
        alt={decorative ? '' : `Photo of ${name}`}
        width={size}
        height={size}
        loading="lazy"
        decoding="async"
        onError={() => setFailedSrc(src)}
        data-testid={testId}
      />
    );
  }

  const label = `${name}, ${sexLabel[sex]}`;
  return (
    <span
      className={cx(classes, styles.fallback)}
      style={style}
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : label}
      aria-hidden={decorative || undefined}
      data-fallback={fallback}
      data-testid={testId}
    >
      {fallback === 'initials' && size > 24 ? (
        <span className={styles.initials} style={{ fontSize: Math.round(size * 0.38) }}>
          {initials(name)}
        </span>
      ) : (
        // A head-and-shoulders silhouette, tinted by sex (as on Ancestry).
        <UserRound size={Math.round(size * 0.55)} strokeWidth={size > 40 ? 1.5 : 2} aria-hidden />
      )}
    </span>
  );
}
