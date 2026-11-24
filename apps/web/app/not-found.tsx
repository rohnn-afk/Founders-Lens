import Link from 'next/link';
import styles from './public.module.css';

export default function NotFound() {
  return (
    <main className={styles.hero}>
      <h1>Page not found</h1>
      <p>This page may have moved or may be unavailable in this deployment.</p>
      <Link className={styles.action} href="/">Return home</Link>
    </main>
  );
}
