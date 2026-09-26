import { useEffect, type ReactNode } from 'react'
import './landing.css'

// /privacy and /terms: what the app keeps, why, and how to get rid of it.
// Plain language, and only what the code actually does — update these when that changes.

const CONTACT = 'krishna@profitwise.app'
const UPDATED = 'September 26, 2026'

function Page({ title, children }: { title: string; children: ReactNode }) {
  useEffect(() => {
    const prev = document.title
    document.title = `${title} · facemash`
    return () => {
      document.title = prev
    }
  }, [title])
  return (
    <div className="landing legal-page">
      <header className="muse-nav">
        <a className="brand" href="/">
          <svg viewBox="0 0 32 32" aria-hidden="true">
            <rect x="7" y="2" width="18" height="28" rx="9" fill="#3B63C4" />
            <rect x="11.5" y="7.5" width="12" height="8" rx="4" fill="#fff" />
            <circle cx="15.5" cy="11.5" r="1.25" fill="#1B1D24" />
            <circle cx="19.5" cy="11.5" r="1.25" fill="#1B1D24" />
          </svg>
          HackGT 13
        </a>
      </header>
      <main className="legal">
        <h1>{title}</h1>
        <p className="legal-updated">Last updated {UPDATED}</p>
        {children}
        <nav className="legal-links" aria-label="Legal">
          <a href="/privacy">Privacy Policy</a>
          <a href="/terms">Terms of Service</a>
          <a href="/">Home</a>
        </nav>
      </main>
    </div>
  )
}

export function Privacy() {
  return (
    <Page title="Privacy Policy">
      <p>
        This app (the landing page, the game at /play, the Bean Studio at /avatar and the Muse connection at /muse) is
        facemash, a project built at HackGT 13. It is not run by HackGT. This page explains what we collect, why, where
        it lives, and how to delete it.
      </p>

      <h2>What we collect</h2>
      <ul>
        <li>
          <b>If you sign in with Google:</b> your name, email address, first name, profile photo and Google account ID.
          We only accept emails Google has verified, and your email is how we recognise your account. We never see your
          Google password.
        </li>
        <li>
          <b>When you play:</b> the name and colour you choose, the bean you design, and where your bean is in the game
          (outdoors on the virtual campus or inside the Klaus atrium). If you are signed in, we save your last position
          so you can pick up where you left off. Chat messages are passed to other players nearby in real time; we do not
          store them.
        </li>
        <li>
          <b>If you turn on live location</b> (optional, on phones): your phone's location, and step and compass readings
          worked out on your phone, are used to place your bean where you are in the Klaus atrium. We keep location
          samples to calibrate positioning in the building.
        </li>
        <li>
          <b>If you connect your Muse</b> (optional): we create a personal key for your Muse and store only a scrambled
          (hashed) copy of it. We log which tools your Muse calls and how long they take, but not what it asks. When
          you connect it, your Muse sends what it remembers about you; we store that copy in our database and in our memory
          service so your Muse can look things up for you. We ask your Muse not to include anything about other people, and
          you can delete it any time on the /muse page.
        </li>
        <li>
          <b>In your browser:</b> a sign-in cookie (it lasts up to 30 days) and a few settings saved on your device, such
          as your name, colour, bean, and whether you allowed location or motion.
        </li>
      </ul>

      <h2>How we use it</h2>
      <ul>
        <li>To run the game and show your bean to other players.</li>
        <li>To remember your account, your bean and where you left off.</li>
        <li>To let your own Muse answer questions about HackGT and about you, from your own saved memory.</li>
        <li>
          To help you find people you would want to meet at the event. You are not shown to other attendees unless you
          turn that on yourself, and then only the short card you approve is shared, never your saved memory.
        </li>
      </ul>
      <p>We do not sell your data, show ads, or use your data to train AI models.</p>

      <h2>Who else handles it</h2>
      <ul>
        <li>
          <b>Google Cloud</b> hosts our servers and database, and Google's Gemini API turns saved memory into search
          indexes (embeddings) so it can be searched by meaning.
        </li>
        <li>
          <b>TypeSafe</b> (the Jev model) reads a trimmed copy of your saved memory, with credentials already removed, to
          pick an outfit for your bean.
        </li>
        <li>
          <b>Google</b> handles sign-in.
        </li>
        <li>
          <b>Vercel</b> serves the website and passes requests to our servers.
        </li>
        <li>
          <b>Your Muse</b> (Meta) receives the answers we send it, because you connected it. Meta's own terms and privacy
          policy cover what Muse does with them.
        </li>
      </ul>

      <h2>How long we keep it</h2>
      <p>
        Data from HackGT 13 is deleted 30 days after the event ends, unless you ask us to keep your account. Database
        backups are kept for up to 7 days, so anything deleted leaves our backups within 7 days after that.
      </p>

      <h2>Deleting your data</h2>
      <ul>
        <li>On the /muse page you can disconnect your Muse and delete the memory it sent us.</li>
        <li>
          To delete your whole account, email <a href={`mailto:${CONTACT}`}>{CONTACT}</a> from the address you signed in
          with. We delete it and confirm.
        </li>
      </ul>

      <h2>Security</h2>
      <p>
        Data is encrypted in transit. The database and memory service are reachable only from our own servers, keys are
        stored as hashes, and each attendee's saved memory is kept in a space only that attendee's key can search.
      </p>

      <h2>Children</h2>
      <p>This app is for HackGT attendees and is not meant for anyone under 13.</p>

      <h2>Changes and contact</h2>
      <p>
        If this policy changes, we update the date at the top. Questions or requests:{' '}
        <a href={`mailto:${CONTACT}`}>{CONTACT}</a>.
      </p>
    </Page>
  )
}

export function Terms() {
  return (
    <Page title="Terms of Service">
      <p>
        facemash is a project built at HackGT 13 (the landing page, the game at /play, the Bean Studio at /avatar and the
        Muse connection at /muse). It is not run by HackGT. By using it you agree to these terms.
      </p>

      <h2>Using the app</h2>
      <ul>
        <li>Be kind. No harassment, hate, spam, or impersonating someone else, in chat or anywhere else in the app.</li>
        <li>Choose a display name you would be happy for other attendees to see.</li>
        <li>Don't try to access other people's accounts or data, or to break, overload or scrape the service.</li>
        <li>
          If you connect your Muse, you are responsible for what it sends us, including making sure it only sends
          information about you.
        </li>
      </ul>

      <h2>Your content</h2>
      <p>
        You own what you create and send us: your bean, your name, your card, and your Muse's memory. You let us store and
        use it only to run the app for you, as described in the <a href="/privacy">Privacy Policy</a>.
      </p>

      <h2>Accounts</h2>
      <p>
        You can use the app as a guest, or sign in with Google to save your progress. We may remove content or suspend
        access that breaks these terms.
      </p>

      <h2>No warranty</h2>
      <p>
        This is a hackathon project, provided as is. It may change, go down, or lose data, and live location inside the
        building is approximate. Don't rely on it for anything important or for safety.
      </p>

      <h2>Limitation of liability</h2>
      <p>
        To the extent the law allows, the facemash team is not liable for indirect or consequential damages arising from
        your use of the app.
      </p>

      <h2>Changes and contact</h2>
      <p>
        We may update these terms and will change the date at the top when we do. Questions:{' '}
        <a href={`mailto:${CONTACT}`}>{CONTACT}</a>.
      </p>
    </Page>
  )
}
