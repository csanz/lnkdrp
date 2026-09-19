/**
 * Privacy Policy page.
 *
 * Public privacy policy page, linked from the shared public footer.
 *
 * Every claim here should be backed by the code. Notable facts this page reflects: Google-only
 * sign-in, anonymous browser identities, share-viewer tracking (including IP addresses), OpenAI as
 * the AI processor (text and page images), Vercel Blob + MongoDB storage, Resend email, Stripe
 * billing, no third-party analytics, soft deletes, and no self-service deletion or export yet.
 * `LAST_UPDATED` is a fixed date, bumped by hand whenever the wording changes.
 */
/* eslint-disable react/no-unescaped-entities */
"use client";

import Link from "next/link";
import PublicFooter from "@/components/PublicFooter";
import PublicHeader from "@/components/PublicHeader";

const LAST_UPDATED = "September 16, 2026";

/**
 * Render the PrivacyPolicyPage UI.
 */
export default function PrivacyPolicyPage() {
  return (
    <main className="relative min-h-[100svh] w-full overflow-hidden bg-[#050506] text-white">
      {/* Soft lighting background effect */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(1200px 700px at 80% 20%, rgba(255,255,255,0.10), rgba(255,255,255,0) 60%), radial-gradient(900px 500px at 20% 60%, rgba(255,255,255,0.06), rgba(255,255,255,0) 55%), radial-gradient(700px 500px at 60% 85%, rgba(255,255,255,0.05), rgba(255,255,255,0) 60%)",
        }}
      />

      {/* Content overlay */}
      <div className="relative z-10 min-h-[100svh] w-full">
        <PublicHeader />

        <div className="mx-auto w-full max-w-3xl px-8 pb-24 pt-12 sm:px-10 md:pt-16 lg:px-12">
        <p className="mb-4 text-[11px] font-semibold uppercase tracking-[0.16em] text-white/55">Legal</p>
        <h1 className="font-serif text-5xl leading-[1.02] tracking-tight text-white sm:text-6xl md:text-[56px]">
          Privacy Policy
        </h1>
        <p className="mb-14 mt-6 text-sm text-white/45">Last updated: {LAST_UPDATED}</p>

        <div className="space-y-10 text-sm leading-6 text-white/60 sm:text-[15px]">
          <section>
            <h2 className="mb-3 font-serif text-2xl tracking-tight text-white">1. Introduction</h2>
            <p className="mb-4 leading-6">
              LinkDrop ("we", "us", or "our") is committed to protecting your privacy. This Privacy Policy explains how we collect, use, disclose, and safeguard information when you use our document sharing platform and related services (collectively, the "Service").
            </p>
            <p className="mb-4 leading-6">
              It applies to two kinds of people: <strong>account holders</strong> who upload and share documents, and <strong>viewers</strong> who open a link someone shared with them. Section 5 is written for viewers.
            </p>
            <p className="leading-6">
              By using the Service, you agree to the collection and use of information in accordance with this Privacy Policy. If you do not agree with our policies and practices, please do not use the Service.
            </p>
          </section>

          <section>
            <h2 className="mb-3 font-serif text-2xl tracking-tight text-white">2. Information We Collect</h2>

            <h3 className="mb-2 mt-4 text-sm font-semibold text-white">2.1 Information You Provide</h3>
            <ul className="mb-4 ml-6 list-disc space-y-2 leading-6">
              <li><strong>Account Information:</strong> Sign-in is through Google only. When you sign in, Google gives us your email address, name, Google account identifier, and profile picture URL. We store these and the time of your last sign-in. We do not store a password.</li>
              <li><strong>Documents and Content:</strong> We store the PDF documents you upload or import from a URL, along with the text we extract from them, a preview image, an image of each page, and your document titles and settings.</li>
              <li><strong>AI Output:</strong> Summaries, key points, and version comparisons generated for your documents are stored with them. We also keep a record of each AI run, including the prompt sent and the response received, so we can show you results, count credits, and debug problems.</li>
              <li><strong>Workspace Information:</strong> If you create or join a workspace, we store the workspace name, optional icon, its members and their roles, and any invitation you send (including the invitee's email address if you enter one).</li>
              <li><strong>Preferences:</strong> Notification settings, starred documents, and similar choices you make in the app.</li>
              <li><strong>Communication:</strong> When you contact us for support, we collect your email address and any information you provide in your message.</li>
              <li><strong>Payment Information:</strong> If a workspace upgrades to Pro, you enter your card details on Stripe's checkout page. Stripe gives us a customer identifier, subscription status, billing period dates, and metered usage totals. We never see or store your full card number.</li>
            </ul>

            <h3 className="mb-2 mt-4 text-sm font-semibold text-white">2.2 Information Collected Automatically</h3>
            <ul className="mb-4 ml-6 list-disc space-y-2 leading-6">
              <li><strong>Anonymous Identity:</strong> If you use parts of the Service without signing in, we create a random identifier and secret stored in your browser so your uploads stay attached to that browser until you sign in and claim them. We store only a hash of the secret.</li>
              <li><strong>Product Usage (signed-in users):</strong> Which pages of the app you visit, the page that referred you, and how long you stay, tied to a hashed per-session identifier. We use this to understand which features are used.</li>
              <li><strong>Viewer Activity on Share Links:</strong> Described in section 5. This includes the viewer's IP address.</li>
              <li><strong>Error and Security Logs:</strong> When something fails we record the route, the error message and stack trace, your user identifier if you were signed in, and a sanitized copy of the request context. Error records are deleted automatically after 14 days. Our rate-limiting records key on IP address (and, for download requests, a hash of the email entered) and expire automatically after the limit window.</li>
              <li><strong>Hosting Logs:</strong> Our hosting provider keeps standard request logs (IP address, timestamp, URL, browser type) for a limited period as part of operating the Service.</li>
            </ul>
            <p className="mb-4 leading-6">
              We do not fingerprint devices, we do not store browser user-agent strings in our own database, and we do not run any third-party analytics or advertising trackers.
            </p>

            <h3 className="mb-2 mt-4 text-sm font-semibold text-white">2.3 Information from Third Parties</h3>
            <ul className="mb-4 ml-6 list-disc space-y-2 leading-6">
              <li><strong>Google:</strong> Your email, name, account identifier, and profile picture URL when you sign in.</li>
              <li><strong>Stripe:</strong> Transaction and subscription status, billing period dates, and invoice availability needed to run your plan.</li>
            </ul>
          </section>

          <section>
            <h2 className="mb-3 font-serif text-2xl tracking-tight text-white">3. How We Use Your Information</h2>
            <p className="mb-4 leading-6">
              We use the information we collect to:
            </p>
            <ul className="mb-4 ml-6 list-disc space-y-2 leading-6">
              <li>Provide, maintain, and improve the Service</li>
              <li>Store, process, and display your documents, including sending document text and page images to our AI provider to generate summaries, key points, and version comparisons</li>
              <li>Show you who viewed your shared documents and how they engaged with them</li>
              <li>Create and manage your account, workspaces, memberships, and settings</li>
              <li>Generate share links and enforce the access controls you set on them</li>
              <li>Meter credits, process payments, and manage subscriptions</li>
              <li>Send service emails: workspace invitations; document activity notifications and digests, which are on by default and which you can turn off at any time in your settings (view notifications can also be turned off from the email itself); and download-request and approval messages</li>
              <li>Detect, prevent, and address technical issues, abuse, and security threats, including rate limiting</li>
              <li>Comply with legal obligations and enforce our Terms of Service</li>
            </ul>
            <p className="mb-4 leading-6">
              <strong>Notification change, effective September 16, 2026:</strong> document activity emails now include
              view notifications, which tell workspace members that someone opened a shared document. They are on by
              default, so this section no longer describes activity emails as ones you have opted into.
            </p>
            <p className="leading-6">
              We do not use your information for advertising, and we do not sell it.
            </p>
          </section>

          <section>
            <h2 className="mb-3 font-serif text-2xl tracking-tight text-white">4. How We Share Your Information</h2>
            <p className="mb-4 leading-6">
              We do not sell your personal information. We share information only in the following circumstances:
            </p>

            <h3 className="mb-2 mt-4 text-sm font-semibold text-white">4.1 With People You Choose</h3>
            <p className="mb-4 leading-6">
              When you share a document link, recipients see the document, its AI summary and key points, and the title you gave it. When you invite someone to a workspace, they see the documents, projects, and members in it. When you approve a download request, the requester receives the file.
            </p>

            <h3 className="mb-2 mt-4 text-sm font-semibold text-white">4.2 Service Providers</h3>
            <p className="mb-4 leading-6">
              We rely on the following providers to operate the Service. Each receives only what it needs for its role:
            </p>
            <ul className="mb-4 ml-6 list-disc space-y-2 leading-6">
              <li><strong>Google (Google LLC):</strong> Sign-in. Receives your sign-in requests.</li>
              <li><strong>Vercel (Vercel Inc.):</strong> Hosting, request logs, scheduled jobs, and file storage. Your PDFs, page images, preview images, extracted text, and workspace icons are stored in Vercel Blob storage at addresses that are not listed publicly.</li>
              <li><strong>MongoDB (MongoDB Atlas):</strong> Our database. Holds account, workspace, document text, AI output, viewer activity, billing, and log records.</li>
              <li><strong>OpenAI (OpenAI, L.L.C.):</strong> AI processing. Receives the extracted text of your documents and images of their pages when a summary or version comparison is generated. See section 6.</li>
              <li><strong>Stripe (Stripe, Inc.):</strong> Payments and subscriptions. Receives your email address and workspace identifier when you upgrade, and metered usage totals for on-demand credits.</li>
              <li><strong>Resend (Resend, Inc.):</strong> Sends our transactional email. Receives the recipient address and message content of each email we send.</li>
            </ul>
            <p className="mb-4 leading-6">
              Our public homepage loads a world map dataset from a public CDN (jsDelivr or unpkg) to draw its animation; that request exposes your IP address to the CDN, as any web resource load does. No such requests are made inside the signed-in app.
            </p>

            <h3 className="mb-2 mt-4 text-sm font-semibold text-white">4.3 Legal Requirements</h3>
            <p className="mb-4 leading-6">
              We may disclose your information if required by law, regulation, legal process, or governmental request, or to protect our rights, property, or safety, or that of our users or others.
            </p>

            <h3 className="mb-2 mt-4 text-sm font-semibold text-white">4.4 Business Transfers</h3>
            <p className="leading-6">
              In the event of a merger, acquisition, reorganization, or sale of assets, your information may be transferred as part of that transaction. We will notify you of any such change in ownership or control.
            </p>
          </section>

          <section>
            <h2 className="mb-3 font-serif text-2xl tracking-tight text-white">5. If Someone Shared a Document With You</h2>
            <p className="mb-4 leading-6">
              This section is for people who open a LinkDrop share link. You do not need an account to do so, but the document owner can see how you interacted with what they shared.
            </p>
            <p className="mb-4 leading-6">
              When you open a share link we record the following. Everything except your IP address is shown to the document owner:
            </p>
            <ul className="mb-4 ml-6 list-disc space-y-2 leading-6">
              <li>That the document was opened, which pages you viewed, how long you spent on each page, and how many times you returned to a page</li>
              <li>Whether you downloaded the PDF, if the owner enabled downloads</li>
              <li>Your IP address, which we keep for security and abuse prevention. It is not shown to the document owner.</li>
              <li>Your name and email address, <strong>only if you choose to enter them</strong> when the viewer asks you to introduce yourself. You can decline. If you are signed in to LinkDrop, your account identity is used instead.</li>
            </ul>
            <p className="mb-4 leading-6">
              The document owner and members of their workspace may be emailed when you open it, and that email can include the details above that are shown to the owner.
            </p>
            <p className="mb-4 leading-6">
              To tell repeat visits apart we store a random identifier in your browser's local storage. On our side we keep only a hash of it. It is not shared with anyone else and is not linked across different owners' documents. Clearing your browser storage removes it.
            </p>
            <p className="mb-4 leading-6">
              If the owner has not enabled downloads, you can request one by entering your email address. We email the owner to ask for approval; if they approve, we email you a link, and you must sign in with Google to receive the file. Your email address is stored with that request.
            </p>
            <p className="leading-6">
              Password protection on a share link is set by the owner. When you enter a correct password we set a cookie so you do not have to re-enter it for 14 days on that browser.
            </p>
          </section>

          <section>
            <h2 className="mb-3 font-serif text-2xl tracking-tight text-white">6. AI Processing</h2>
            <p className="mb-4 leading-6">
              We use OpenAI's API to generate summaries, key points, and version comparisons. When an AI feature runs, we send the extracted text of the document and, for some features, images of its pages, together with our instructions. For version comparisons we send page images from both versions.
            </p>
            <ul className="mb-4 ml-6 list-disc space-y-2 leading-6">
              <li>A summary is generated automatically when a document finishes uploading. Comparisons run when you or someone in your workspace asks for them.</li>
              <li>AI output is stored with the document and shown to you; summaries and key points are also shown to viewers of the share link.</li>
              <li>We keep the prompt and response of each run to display results, meter credits, and investigate failures.</li>
              <li>We do not train AI models. Under OpenAI's API data usage policy, content sent through the API is not used to train OpenAI's models. We have not opted in to any data-sharing program.</li>
              <li>AI output is provided for informational purposes only and can be inaccurate. It is not professional advice.</li>
            </ul>
            <p className="leading-6">
              Uploading a document means its content will be processed this way. If you do not want a document sent to our AI provider, do not upload it.
            </p>
          </section>

          <section>
            <h2 className="mb-3 font-serif text-2xl tracking-tight text-white">7. Data Security</h2>
            <p className="mb-4 leading-6">
              We implement technical measures to protect your information, including:
            </p>
            <ul className="mb-4 ml-6 list-disc space-y-2 leading-6">
              <li>Encryption of data in transit (HTTPS/TLS)</li>
              <li>Sign-in delegated to Google; no passwords are stored by us</li>
              <li>Share passwords stored as salted hashes; invitation, download, and request tokens stored as hashes; anonymous-identity secrets stored as hashes</li>
              <li>Files stored at unlisted addresses, with access through the app controlled by the owner's share settings</li>
              <li>Role-based access to workspaces and rate limiting on public endpoints</li>
              <li>Automatic redaction of secrets from error logs</li>
            </ul>
            <p className="leading-6">
              No method of transmission over the internet or electronic storage is completely secure. While we strive to protect your information, we cannot guarantee absolute security.
            </p>
          </section>

          <section>
            <h2 className="mb-3 font-serif text-2xl tracking-tight text-white">8. Data Retention and Deletion</h2>
            <p className="mb-4 leading-6">
              We retain your information for as long as your account exists and as needed to provide the Service, unless a longer period is required by law. Specifically:
            </p>
            <ul className="mb-4 ml-6 list-disc space-y-2 leading-6">
              <li><strong>Deleting a document, project, or workspace</strong> in the app removes it from your view and disables its share links immediately. The underlying records and files are marked deleted rather than erased right away, and may remain in our systems and backups until they are purged. Contact us if you need a document permanently erased.</li>
              <li><strong>Viewer activity</strong> is kept for as long as the related document exists.</li>
              <li><strong>Error records</strong> are deleted automatically after 14 days. Rate-limit records expire after their window.</li>
              <li><strong>Billing records</strong> are kept as required for tax and accounting purposes.</li>
            </ul>
            <p className="leading-6">
              We do not yet offer self-service account deletion or data export. To close your account, delete specific information, or receive a copy of your data, email hi@lnkdrp.com and we will handle it manually.
            </p>
          </section>

          <section>
            <h2 className="mb-3 font-serif text-2xl tracking-tight text-white">9. Your Rights and Choices</h2>
            <p className="mb-4 leading-6">
              Depending on your location, you may have rights regarding your personal information, including:
            </p>
            <ul className="mb-4 ml-6 list-disc space-y-2 leading-6">
              <li><strong>Access:</strong> Request access to the personal information we hold about you</li>
              <li><strong>Correction:</strong> Request correction of inaccurate or incomplete information</li>
              <li><strong>Deletion:</strong> Request deletion of your personal information</li>
              <li><strong>Portability:</strong> Request a copy of your data in a portable format</li>
              <li><strong>Objection:</strong> Object to certain processing of your information</li>
              <li><strong>Restriction:</strong> Request restriction of processing in certain circumstances</li>
            </ul>
            <p className="mb-4 leading-6">
              To exercise these rights, contact us at hi@lnkdrp.com. We will respond within a reasonable timeframe and in accordance with applicable law. If you were a viewer of someone else's document, we may need to confirm the request with the document owner.
            </p>
            <p className="leading-6">
              In the app you can change your display name, leave workspaces, remove members from workspaces you administer, delete documents, and turn document activity emails off, to a daily digest, or to immediate in your notification settings.
            </p>
          </section>

          <section>
            <h2 className="mb-3 font-serif text-2xl tracking-tight text-white">10. Children's Privacy</h2>
            <p className="leading-6">
              The Service is not intended for individuals under the age of 13 (or the minimum age in your jurisdiction). We do not knowingly collect personal information from children. If you believe we have collected information from a child, please contact us immediately at hi@lnkdrp.com, and we will take steps to delete such information.
            </p>
          </section>

          <section>
            <h2 className="mb-3 font-serif text-2xl tracking-tight text-white">11. International Data Transfers</h2>
            <p className="mb-4 leading-6">
              The Service is operated from the United States, and our service providers listed in section 4.2 process data in the United States and other countries. If you are located elsewhere, your information will be transferred to, stored, and processed in those locations, which may have different data protection laws than your country of residence.
            </p>
            <p className="leading-6">
              By using the Service, you consent to these transfers.
            </p>
          </section>

          <section>
            <h2 className="mb-3 font-serif text-2xl tracking-tight text-white">12. California Privacy Rights</h2>
            <p className="mb-4 leading-6">
              If you are a California resident, you have additional rights under the California Consumer Privacy Act (CCPA), including:
            </p>
            <ul className="mb-4 ml-6 list-disc space-y-2 leading-6">
              <li>The right to know what personal information we collect, use, and disclose</li>
              <li>The right to delete your personal information (subject to certain exceptions)</li>
              <li>The right to opt-out of the sale of personal information (we do not sell personal information)</li>
              <li>The right to non-discrimination for exercising your privacy rights</li>
            </ul>
            <p className="leading-6">
              To exercise these rights, please contact us at hi@lnkdrp.com.
            </p>
          </section>

          <section>
            <h2 className="mb-3 font-serif text-2xl tracking-tight text-white">13. European Privacy Rights</h2>
            <p className="mb-4 leading-6">
              If you are located in the European Economic Area (EEA) or United Kingdom, you have additional rights under the General Data Protection Regulation (GDPR), including:
            </p>
            <ul className="mb-4 ml-6 list-disc space-y-2 leading-6">
              <li>The right to access, rectify, or erase your personal data</li>
              <li>The right to restrict or object to processing</li>
              <li>The right to data portability</li>
              <li>The right to withdraw consent at any time</li>
              <li>The right to lodge a complaint with a supervisory authority</li>
            </ul>
            <p className="leading-6">
              Our legal bases for processing are: performance of our contract with you (providing the Service you signed up for), our legitimate interests (securing the Service, preventing abuse, understanding how features are used, and showing document owners how their shared documents are viewed), compliance with legal obligations, and your consent where you give it, for example by entering your name and email as a viewer.
            </p>
          </section>

          <section>
            <h2 className="mb-3 font-serif text-2xl tracking-tight text-white">14. Cookies and Browser Storage</h2>
            <p className="mb-4 leading-6">
              We set a small number of first-party cookies, all needed to run the Service:
            </p>
            <ul className="mb-4 ml-6 list-disc space-y-2 leading-6">
              <li><strong>Session cookie:</strong> Keeps you signed in and records which workspace you are working in.</li>
              <li><strong>Active workspace cookie:</strong> Remembers the workspace you last switched to.</li>
              <li><strong>Share-unlock cookie:</strong> Set after you enter a correct share password so you are not asked again for 14 days. It contains a signed token, not the password.</li>
            </ul>
            <p className="mb-4 leading-6">
              We also use your browser's local storage for the anonymous identifiers described in sections 2.2 and 5, for the name and email you chose to enter as a viewer so they can be prefilled next time, and for caches that make the app load faster (your workspace list, sidebar, and starred documents).
            </p>
            <p className="leading-6">
              We do not use third-party cookies, advertising cookies, or analytics cookies. You can clear or block cookies and site data in your browser, but the Service will not work signed in without the session cookie.
            </p>
          </section>

          <section>
            <h2 className="mb-3 font-serif text-2xl tracking-tight text-white">15. Changes to This Privacy Policy</h2>
            <p className="mb-4 leading-6">
              We may update this Privacy Policy from time to time. We will notify you of material changes by:
            </p>
            <ul className="mb-4 ml-6 list-disc space-y-2 leading-6">
              <li>Posting the updated Privacy Policy on our website</li>
              <li>Updating the "Last updated" date</li>
              <li>Emailing account holders about significant changes</li>
            </ul>
            <p className="leading-6">
              Your continued use of the Service after such modifications constitutes your acceptance of the updated Privacy Policy. If you do not agree to the modified Privacy Policy, you must stop using the Service.
            </p>
          </section>

          <section>
            <h2 className="mb-3 font-serif text-2xl tracking-tight text-white">16. Contact Us</h2>
            <p className="mb-4 leading-6">
              If you have questions, concerns, or requests regarding this Privacy Policy or our privacy practices, please contact us at:
            </p>
            <p className="mb-4 leading-6">
              <strong>Email:</strong> <a href="mailto:hi@lnkdrp.com" className="text-white/80 underline hover:text-white">hi@lnkdrp.com</a>
            </p>
            <p className="leading-6">
              We will respond to your inquiry within a reasonable timeframe. Our <Link href="/tos" className="text-white/80 underline hover:text-white">Terms of Service</Link> describe the rules for using the Service.
            </p>
          </section>
        </div>

        <div className="mt-12 border-t border-white/10 pt-8">
          <Link href="/" className="text-sm font-medium text-white/70 hover:text-white">
            ← Back to home
          </Link>
        </div>
        </div>
        <PublicFooter className="relative pb-6" containerClassName="mx-auto w-full max-w-3xl px-6" />
      </div>
    </main>
  );
}
