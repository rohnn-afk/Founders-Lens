import Link from 'next/link';
import styles from './public.module.css';

export default function Home() {
  return (
    <main className={styles.hero}>
      <h1>Founder&apos;s Lens</h1>
      <p>Test your assumptions, think through decisions, and keep the conversation with the idea that started it.</p>
      <Link className={styles.action} href="/app" prefetch={false}>Open workspace</Link>
    </main>
  );
}
