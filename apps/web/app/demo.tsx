import type { Metadata } from 'next';
import styles from './public.module.css';

const repository = 'https://github.com/rohnn-afk/Founders-Lens';
const description = 'A critical-thinking workspace for early-stage founders. Explore a read-only product preview.';

export function demoMetadata(): Metadata {
  const origin = process.env.RENDER_EXTERNAL_URL;
  const url = origin && /^https:\/\/[a-z0-9-]+\.onrender\.com$/.test(origin) ? origin : undefined;
  return {
    title: "Founder's Lens | Product demo",
    description,
    alternates: url ? { canonical: url } : undefined,
    openGraph: { title: "Founder's Lens", description, type: 'website', url },
    twitter: { card: 'summary', title: "Founder's Lens", description }
  };
}

export function Demo() {
  return (
    <main className={styles.demo}>
      <header className={styles.demoNav}>
        <span>Founder&apos;s Lens</span>
        <nav aria-label="Demo navigation">
          <a href="#preview">Preview</a>
          <a href={repository}>GitHub</a>
        </nav>
      </header>
      <section className={styles.demoGrid} aria-labelledby="demo-title">
        <div className={styles.demoIntro}>
          <h1 id="demo-title">Think clearly about what to build next.</h1>
          <p>Founder&apos;s Lens helps early-stage founders challenge assumptions, weigh the evidence, and decide what to test next.</p>
          <a className={styles.action} href="#preview">Explore the preview</a>
          <p className={styles.demoNote}>This public demo is read-only. Sign-in, private workspaces, and live AI are unavailable.</p>
        </div>
        <section className={styles.preview} id="preview" aria-labelledby="preview-title">
          <p className={styles.previewLabel}>Illustrative conversation</p>
          <h2 id="preview-title">Would shops pay for reusable crates?</h2>
          <div className={styles.previewUser}>
            <h3>Founder</h3>
            <p>Shop owners say packaging waste is a problem. Is that enough to offer a monthly crate subscription?</p>
          </div>
          <div className={styles.previewAssistant}>
            <h3>Example assistant response</h3>
            <p>Complaints suggest a problem worth exploring. Willingness to pay is still a hypothesis.</p>
            <p><strong>Next experiment.</strong> Offer a short paid pilot to five shop owners. Decide up front how many commitments you need before investing in inventory.</p>
          </div>
        </section>
      </section>
      <footer className={styles.demoFooter}>
        <p>The application supports private ideas, saved conversations, and AI-assisted analysis.</p>
        <a href={repository}>View the source on GitHub</a>
      </footer>
    </main>
  );
}
