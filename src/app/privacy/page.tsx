/**
 * Privacy Policy page.
 *
 * Public privacy policy page accessible from the logged-out homepage.
 */
"use client";

import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useCallback } from "react";
import { signIn } from "next-auth/react";
import { useAuthEnabled } from "@/app/providers";
import Modal from "@/components/modals/Modal";
import AboutCopy from "@/components/AboutCopy";
import { useState } from "react";

/**
 * Render the PrivacyPolicyPage UI.
 */
export default function PrivacyPolicyPage() {
  const router = useRouter();
  const authEnabled = useAuthEnabled();
  const [aboutModalOpen, setAboutModalOpen] = useState(false);
  const [isSigningIn, setIsSigningIn] = useState(false);

  const startAuthFlow = useCallback(async () => {
    if (!authEnabled) return;
    setIsSigningIn(true);
    try {
      await signIn("google", { callbackUrl: "/" });
    } catch {
      router.push("/login");
    } finally {
      setIsSigningIn(false);
    }
  }, [authEnabled, router]);

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
        {/* Full-width header: logo pinned left, auth links pinned right */}
        <header className="w-full">
        <div className="flex h-14 items-center justify-between gap-3 px-3 md:h-auto md:items-start md:px-4 md:pb-7 md:pt-6">
          <div className="flex min-w-0 items-center gap-2">
            <Link href="/" className="inline-flex items-center gap-2" aria-label="Home">
              <Image
                src="/icon-white.svg?v=3"
                alt="LinkDrop"
                width={31}
                height={31}
                priority
                className="block"
              />
            </Link>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="rounded-xl px-3 py-2 text-sm font-medium text-white/70 transition hover:bg-white/5 hover:text-white"
              onClick={() => setAboutModalOpen(true)}
            >
              About
            </button>
            <Link
              href="/tos"
              className="rounded-xl px-3 py-2 text-sm font-medium text-white/70 transition hover:bg-white/5 hover:text-white"
            >
              Terms
            </Link>
            <Link
              href="/privacy"
              className="rounded-xl px-3 py-2 text-sm font-medium text-white/70 transition hover:bg-white/5 hover:text-white"
            >
              Privacy
            </Link>
            <button
              type="button"
              className="rounded-xl px-3 py-2 text-sm font-medium text-white/70 transition hover:bg-white/5 hover:text-white"
              onClick={() => void startAuthFlow()}
              disabled={isSigningIn}
            >
              Log In
            </button>
          </div>
        </div>
      </header>

        <div className="mx-auto w-full max-w-3xl px-6 py-12">
        <h1 className="mb-2 text-3xl font-semibold tracking-tight text-white">Privacy Policy</h1>
        <p className="mb-12 text-sm text-white/60">Last updated: {new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}</p>

        <div className="prose prose-sm max-w-none space-y-8 text-white/80">
          <section>
            <h2 className="mb-3 text-xl font-semibold text-white">1. Introduction</h2>
            <p className="mb-4 leading-7">
              LinkDrop ("we," "us," or "our") is committed to protecting your privacy. This Privacy Policy explains how we collect, use, disclose, and safeguard your information when you use our document sharing platform and related services (collectively, the "Service").
            </p>
            <p className="leading-7">
              By using the Service, you agree to the collection and use of information in accordance with this Privacy Policy. If you do not agree with our policies and practices, please do not use the Service.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-semibold text-white">2. Information We Collect</h2>
            
            <h3 className="mb-2 mt-4 text-lg font-semibold text-white">2.1 Information You Provide</h3>
            <p className="mb-4 leading-7">
              We collect information that you provide directly to us, including:
            </p>
            <ul className="mb-4 ml-6 list-disc space-y-2 leading-7">
              <li><strong>Account Information:</strong> When you create an account, we collect your name, email address, and profile information. We use Google Sign-In for authentication, which provides us with your Google account email and name.</li>
              <li><strong>Documents and Content:</strong> We store the PDF documents you upload to the Service, along with extracted text, preview images, and any metadata associated with your documents.</li>
              <li><strong>Organization Information:</strong> If you create or join an organization, we collect organization names, member information, and workspace settings.</li>
              <li><strong>Communication:</strong> When you contact us for support or request an invite, we collect your email address and any information you provide in your message.</li>
              <li><strong>Payment Information:</strong> If you purchase a subscription, payment information is processed by third-party payment processors (such as Stripe). We do not store your full payment card details.</li>
            </ul>

            <h3 className="mb-2 mt-4 text-lg font-semibold text-white">2.2 Information Automatically Collected</h3>
            <p className="mb-4 leading-7">
              When you use the Service, we automatically collect certain information, including:
            </p>
            <ul className="mb-4 ml-6 list-disc space-y-2 leading-7">
              <li><strong>Usage Data:</strong> Information about how you interact with the Service, such as pages viewed, documents accessed, share links created, and features used.</li>
              <li><strong>Device Information:</strong> Device type, operating system, browser type and version, IP address, and device identifiers.</li>
              <li><strong>Log Data:</strong> Server logs, including timestamps, request URLs, error messages, and performance metrics.</li>
              <li><strong>Analytics:</strong> Aggregated usage statistics, document view counts, share link analytics, and engagement metrics.</li>
            </ul>

            <h3 className="mb-2 mt-4 text-lg font-semibold text-white">2.3 Information from Third Parties</h3>
            <p className="leading-7">
              We may receive information about you from third-party services:
            </p>
            <ul className="mb-4 ml-6 list-disc space-y-2 leading-7">
              <li><strong>Authentication Providers:</strong> When you sign in with Google, we receive your Google account information (email, name) as permitted by your Google account settings.</li>
              <li><strong>Payment Processors:</strong> Payment processors provide us with transaction information, subscription status, and billing details necessary to process payments.</li>
            </ul>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-semibold text-white">3. How We Use Your Information</h2>
            <p className="mb-4 leading-7">
              We use the information we collect to:
            </p>
            <ul className="mb-4 ml-6 list-disc space-y-2 leading-7">
              <li>Provide, maintain, and improve the Service</li>
              <li>Process and store your documents, including AI-powered analysis and review features</li>
              <li>Create and manage your account, organizations, and workspace settings</li>
              <li>Enable document sharing, including generating shareable links and managing access controls</li>
              <li>Process payments and manage subscriptions</li>
              <li>Send you service-related communications, such as account updates, security alerts, and support responses</li>
              <li>Monitor and analyze usage patterns to improve the Service and develop new features</li>
              <li>Detect, prevent, and address technical issues, security threats, and fraudulent activity</li>
              <li>Comply with legal obligations and enforce our Terms of Service</li>
            </ul>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-semibold text-white">4. How We Share Your Information</h2>
            <p className="mb-4 leading-7">
              We do not sell your personal information. We may share your information in the following circumstances:
            </p>

            <h3 className="mb-2 mt-4 text-lg font-semibold text-white">4.1 With Your Consent</h3>
            <p className="mb-4 leading-7">
              We share information when you explicitly consent, such as when you share a document link with others or invite members to your organization.
            </p>

            <h3 className="mb-2 mt-4 text-lg font-semibold text-white">4.2 Service Providers</h3>
            <p className="mb-4 leading-7">
              We may share information with third-party service providers who perform services on our behalf, including:
            </p>
            <ul className="mb-4 ml-6 list-disc space-y-2 leading-7">
              <li><strong>Cloud Storage:</strong> We use Vercel Blob Storage to store your documents and files.</li>
              <li><strong>Payment Processing:</strong> Payment processors (such as Stripe) handle subscription billing and payment transactions.</li>
              <li><strong>Authentication:</strong> Google Sign-In provides authentication services.</li>
              <li><strong>Analytics:</strong> We may use analytics services to understand how the Service is used (aggregated and anonymized data).</li>
              <li><strong>Hosting and Infrastructure:</strong> We use cloud hosting providers to operate the Service.</li>
            </ul>
            <p className="leading-7">
              These service providers are contractually obligated to protect your information and use it only for the purposes we specify.
            </p>

            <h3 className="mb-2 mt-4 text-lg font-semibold text-white">4.3 Legal Requirements</h3>
            <p className="mb-4 leading-7">
              We may disclose your information if required by law, regulation, legal process, or governmental request, or to protect our rights, property, or safety, or that of our users or others.
            </p>

            <h3 className="mb-2 mt-4 text-lg font-semibold text-white">4.4 Business Transfers</h3>
            <p className="leading-7">
              In the event of a merger, acquisition, reorganization, or sale of assets, your information may be transferred as part of that transaction. We will notify you of any such change in ownership or control.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-semibold text-white">5. Document Sharing and Public Links</h2>
            <p className="mb-4 leading-7">
              When you create a shareable link for a document, you control who can access it. We provide tools to:
            </p>
            <ul className="mb-4 ml-6 list-disc space-y-2 leading-7">
              <li>Set password protection on share links</li>
              <li>Control whether recipients can download PDFs</li>
              <li>Track who has viewed your shared documents (when available)</li>
            </ul>
            <p className="mb-4 leading-7">
              <strong>Important:</strong> Share links may be accessible to anyone who has the link (unless password-protected). You are responsible for:
            </p>
            <ul className="mb-4 ml-6 list-disc space-y-2 leading-7">
              <li>Keeping your share links secure and not sharing them publicly unless intended</li>
              <li>Ensuring you have the right to share the documents you upload</li>
              <li>Complying with any confidentiality obligations related to shared documents</li>
            </ul>
            <p className="leading-7">
              We are not responsible for unauthorized access to your documents that results from your failure to secure your share links or account credentials.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-semibold text-white">6. AI-Powered Features</h2>
            <p className="mb-4 leading-7">
              The Service uses artificial intelligence to analyze, summarize, and review your documents. When you use AI features:
            </p>
            <ul className="mb-4 ml-6 list-disc space-y-2 leading-7">
              <li>We process your document content through AI services to generate summaries, reviews, and insights</li>
              <li>AI-generated content is stored on our servers and associated with your account</li>
              <li>We may use aggregated, anonymized data to improve our AI models and features</li>
              <li>AI-generated content is provided for informational purposes only and should not be relied upon as professional advice</li>
            </ul>
            <p className="leading-7">
              We do not use your document content to train third-party AI models without your explicit consent, except in aggregated and anonymized form.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-semibold text-white">7. Data Security</h2>
            <p className="mb-4 leading-7">
              We implement technical and organizational measures to protect your information, including:
            </p>
            <ul className="mb-4 ml-6 list-disc space-y-2 leading-7">
              <li>Encryption of data in transit (HTTPS/TLS)</li>
              <li>Secure storage of documents and data</li>
              <li>Access controls and authentication mechanisms</li>
              <li>Regular security assessments and updates</li>
              <li>Employee training on data protection</li>
            </ul>
            <p className="leading-7">
              However, no method of transmission over the internet or electronic storage is 100% secure. While we strive to protect your information, we cannot guarantee absolute security.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-semibold text-white">8. Data Retention</h2>
            <p className="mb-4 leading-7">
              We retain your information for as long as necessary to provide the Service and fulfill the purposes described in this Privacy Policy, unless a longer retention period is required or permitted by law.
            </p>
            <p className="mb-4 leading-7">
              When you delete your account or documents:
            </p>
            <ul className="mb-4 ml-6 list-disc space-y-2 leading-7">
              <li>We will delete your account information and associated documents from our active systems</li>
              <li>Some information may remain in backup systems for a limited period</li>
              <li>We may retain certain information as required by law or for legitimate business purposes (e.g., transaction records, security logs)</li>
            </ul>
            <p className="leading-7">
              If you wish to delete your account or request deletion of specific information, please contact us at hi@lnkdrp.com.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-semibold text-white">9. Your Rights and Choices</h2>
            <p className="mb-4 leading-7">
              Depending on your location, you may have certain rights regarding your personal information, including:
            </p>
            <ul className="mb-4 ml-6 list-disc space-y-2 leading-7">
              <li><strong>Access:</strong> Request access to the personal information we hold about you</li>
              <li><strong>Correction:</strong> Request correction of inaccurate or incomplete information</li>
              <li><strong>Deletion:</strong> Request deletion of your personal information</li>
              <li><strong>Portability:</strong> Request a copy of your data in a portable format</li>
              <li><strong>Objection:</strong> Object to certain processing of your information</li>
              <li><strong>Restriction:</strong> Request restriction of processing in certain circumstances</li>
            </ul>
            <p className="mb-4 leading-7">
              To exercise these rights, please contact us at hi@lnkdrp.com. We will respond to your request within a reasonable timeframe and in accordance with applicable law.
            </p>
            <p className="leading-7">
              You can also manage certain aspects of your information through your account settings, such as updating your profile information, managing organization memberships, and controlling notification preferences.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-semibold text-white">10. Children's Privacy</h2>
            <p className="leading-7">
              The Service is not intended for individuals under the age of 13 (or the minimum age in your jurisdiction). We do not knowingly collect personal information from children. If you believe we have collected information from a child, please contact us immediately at hi@lnkdrp.com, and we will take steps to delete such information.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-semibold text-white">11. International Data Transfers</h2>
            <p className="mb-4 leading-7">
              The Service is operated from the United States. If you are located outside the United States, please be aware that your information may be transferred to, stored, and processed in the United States and other countries where our service providers operate.
            </p>
            <p className="leading-7">
              By using the Service, you consent to the transfer of your information to the United States and other countries, which may have different data protection laws than your country of residence.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-semibold text-white">12. California Privacy Rights</h2>
            <p className="mb-4 leading-7">
              If you are a California resident, you have additional rights under the California Consumer Privacy Act (CCPA), including:
            </p>
            <ul className="mb-4 ml-6 list-disc space-y-2 leading-7">
              <li>The right to know what personal information we collect, use, and disclose</li>
              <li>The right to delete your personal information (subject to certain exceptions)</li>
              <li>The right to opt-out of the sale of personal information (we do not sell personal information)</li>
              <li>The right to non-discrimination for exercising your privacy rights</li>
            </ul>
            <p className="leading-7">
              To exercise these rights, please contact us at hi@lnkdrp.com.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-semibold text-white">13. European Privacy Rights</h2>
            <p className="mb-4 leading-7">
              If you are located in the European Economic Area (EEA) or United Kingdom, you have additional rights under the General Data Protection Regulation (GDPR), including:
            </p>
            <ul className="mb-4 ml-6 list-disc space-y-2 leading-7">
              <li>The right to access, rectify, or erase your personal data</li>
              <li>The right to restrict or object to processing</li>
              <li>The right to data portability</li>
              <li>The right to withdraw consent at any time</li>
              <li>The right to lodge a complaint with a supervisory authority</li>
            </ul>
            <p className="leading-7">
              Our legal basis for processing your personal data includes: (1) your consent, (2) performance of a contract, (3) compliance with legal obligations, (4) protection of vital interests, and (5) legitimate interests.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-semibold text-white">14. Cookies and Tracking Technologies</h2>
            <p className="mb-4 leading-7">
              We use cookies and similar tracking technologies to:
            </p>
            <ul className="mb-4 ml-6 list-disc space-y-2 leading-7">
              <li>Maintain your session and authenticate your account</li>
              <li>Remember your preferences and settings</li>
              <li>Analyze how you use the Service</li>
              <li>Provide and improve the Service</li>
            </ul>
            <p className="leading-7">
              You can control cookies through your browser settings. However, disabling cookies may limit your ability to use certain features of the Service.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-semibold text-white">15. Changes to This Privacy Policy</h2>
            <p className="mb-4 leading-7">
              We may update this Privacy Policy from time to time. We will notify you of material changes by:
            </p>
            <ul className="mb-4 ml-6 list-disc space-y-2 leading-7">
              <li>Posting the updated Privacy Policy on our website</li>
              <li>Updating the "Last updated" date</li>
              <li>Sending you an email notification (for significant changes)</li>
            </ul>
            <p className="leading-7">
              Your continued use of the Service after such modifications constitutes your acceptance of the updated Privacy Policy. If you do not agree to the modified Privacy Policy, you must stop using the Service.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-semibold text-white">16. Contact Us</h2>
            <p className="mb-4 leading-7">
              If you have questions, concerns, or requests regarding this Privacy Policy or our privacy practices, please contact us at:
            </p>
            <p className="leading-7">
              <strong>Email:</strong> hi@lnkdrp.com
            </p>
            <p className="leading-7">
              We will respond to your inquiry within a reasonable timeframe.
            </p>
          </section>
        </div>

        <div className="mt-12 border-t border-white/10 pt-8">
          <Link href="/" className="text-sm font-medium text-white/70 hover:text-white">
            ← Back to home
          </Link>
        </div>
        </div>
      </div>

      <Modal
        open={aboutModalOpen}
        onClose={() => setAboutModalOpen(false)}
        ariaLabel="About"
        panelClassName="bg-[#0b0b0c] text-white border-white/10"
        contentClassName="px-8 pb-8 pt-7"
      >
        <div className="flex items-center gap-3">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl border border-white/10 bg-white/5">
            <Image src="/icon-white.svg?v=3" alt="" width={18} height={18} />
          </div>
          <div className="text-base font-semibold text-white">About</div>
        </div>
        <div className="mt-3">
          <AboutCopy />
        </div>
      </Modal>
    </main>
  );
}
