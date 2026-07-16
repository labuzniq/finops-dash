import { avatarTint } from '../lib/avatar.js';
import { initials } from '../lib/format.js';
import styles from './Avatar.module.css';

interface AvatarProps {
  name: string;
  /** Seeds the tint, so a person keeps the same colour everywhere. */
  login: string;
  size: number;
  fontSize: number;
}

export function Avatar({ name, login, size, fontSize }: AvatarProps) {
  return (
    <div
      className={styles.avatar}
      style={{ width: size, height: size, fontSize, background: avatarTint(login) }}
      aria-hidden
    >
      {initials(name)}
    </div>
  );
}
