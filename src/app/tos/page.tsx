/**
 * Terms of Service page.
 *
 * Public terms of service page accessible from the logged-out homepage.
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
 * Render the TermsOfServicePage UI.
 */
export default function TermsOfServicePage() {
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
        <h1 className="mb-2 text-3xl font-semibold tracking-tight text-white">Terms of Service</h1>
        <p className="mb-12 text-sm text-white/60">Last updated: {new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}</p>

        <div className="prose prose-sm max-w-none space-y-8 text-white/80">
          <section>
            <h2 className="mb-3 text-xl font-semibold text-white">1. Acceptance of Terms</h2>
            <p className="mb-4 leading-7">
              By accessing or using LinkDrop ("the Service"), you agree to be bound by these Terms of Service ("Terms"). If you do not agree to these Terms, you may not access or use the Service.
            </p>
            <p className="leading-7">
              LinkDrop is a document sharing platform that enables users to upload, share, and manage PDF documents with AI-powered features for analysis and review. The Service is provided by LinkDrop ("we," "us," or "our").
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-semibold text-white">2. Description of Service</h2>
            <p className="mb-4 leading-7">
              LinkDrop provides a platform for:
            </p>
            <ul className="mb-4 ml-6 list-disc space-y-2 leading-7">
              <li>Uploading and storing PDF documents</li>
              <li>Creating shareable links for documents with optional password protection</li>
              <li>Organizing documents into projects and request repositories</li>
              <li>AI-powered document analysis, review, and summarization</li>
              <li>Tracking document views and engagement metrics</li>
              <li>Collaborative document management within organizations</li>
            </ul>
            <p className="leading-7">
              We reserve the right to modify, suspend, or discontinue any aspect of the Service at any time, with or without notice.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-semibold text-white">3. User Accounts and Access</h2>
            <p className="mb-4 leading-7">
              To use certain features of the Service, you must create an account. You are responsible for:
            </p>
            <ul className="mb-4 ml-6 list-disc space-y-2 leading-7">
              <li>Maintaining the confidentiality of your account credentials</li>
              <li>All activities that occur under your account</li>
              <li>Providing accurate and complete information when creating your account</li>
              <li>Notifying us immediately of any unauthorized use of your account</li>
            </ul>
            <p className="leading-7">
              We reserve the right to suspend or terminate accounts that violate these Terms or engage in fraudulent, abusive, or illegal activity.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-semibold text-white">4. Acceptable Use</h2>
            <p className="mb-4 leading-7">
              You agree not to use the Service to:
            </p>
            <ul className="mb-4 ml-6 list-disc space-y-2 leading-7">
              <li>Upload, share, or distribute any content that is illegal, harmful, threatening, abusive, harassing, defamatory, or otherwise objectionable</li>
              <li>Violate any applicable laws or regulations</li>
              <li>Infringe upon the intellectual property rights of others</li>
              <li>Upload malicious software, viruses, or other harmful code</li>
              <li>Attempt to gain unauthorized access to the Service or other users' accounts</li>
              <li>Use the Service for spam, phishing, or other fraudulent activities</li>
              <li>Interfere with or disrupt the Service or servers connected to the Service</li>
              <li>Reverse engineer, decompile, or disassemble any part of the Service</li>
            </ul>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-semibold text-white">5. Content and Intellectual Property</h2>
            <p className="mb-4 leading-7">
              <strong>Your Content:</strong> You retain ownership of any documents, data, or content you upload to the Service ("Your Content"). By uploading Your Content, you grant us a limited, non-exclusive license to store, process, and display Your Content solely for the purpose of providing the Service to you.
            </p>
            <p className="mb-4 leading-7">
              <strong>Our Content:</strong> The Service, including its design, features, functionality, and all related software, is owned by LinkDrop and protected by copyright, trademark, and other intellectual property laws. You may not copy, modify, distribute, or create derivative works based on the Service without our express written permission.
            </p>
            <p className="leading-7">
              <strong>AI-Generated Content:</strong> The Service may use artificial intelligence to analyze, summarize, or review your documents. AI-generated content is provided for informational purposes only and should not be relied upon as professional advice. We do not guarantee the accuracy, completeness, or reliability of AI-generated content.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-semibold text-white">6. Privacy and Data Protection</h2>
            <p className="mb-4 leading-7">
              Your privacy is important to us. Our collection, use, and protection of your personal information is governed by our <Link href="/privacy" className="text-white underline hover:text-white/80">Privacy Policy</Link>, which is incorporated into these Terms by reference. By using the Service, you consent to the collection and use of your information as described in our Privacy Policy.
            </p>
            <p className="leading-7">
              You are responsible for ensuring that any documents you upload comply with applicable data protection laws and that you have the necessary rights and consents to share such documents through the Service.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-semibold text-white">7. Sharing and Public Links</h2>
            <p className="mb-4 leading-7">
              The Service allows you to create shareable links for your documents. You are solely responsible for:
            </p>
            <ul className="mb-4 ml-6 list-disc space-y-2 leading-7">
              <li>Who you share your links with</li>
              <li>Setting appropriate password protection and access controls</li>
              <li>The content of documents you choose to share</li>
              <li>Complying with any confidentiality obligations related to shared documents</li>
            </ul>
            <p className="leading-7">
              We are not responsible for unauthorized access to your documents that results from your failure to secure your share links or account credentials.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-semibold text-white">8. Subscription and Billing</h2>
            <p className="mb-4 leading-7">
              Certain features of the Service may be available only through paid subscriptions ("Pro" plans). If you purchase a subscription:
            </p>
            <ul className="mb-4 ml-6 list-disc space-y-2 leading-7">
              <li>Subscription fees are billed in advance on a monthly or annual basis</li>
              <li>All fees are non-refundable except as required by law</li>
              <li>We reserve the right to change subscription fees with 30 days' notice</li>
              <li>Your subscription will automatically renew unless cancelled before the renewal date</li>
              <li>You may cancel your subscription at any time, and cancellation will take effect at the end of the current billing period</li>
            </ul>
            <p className="leading-7">
              We use third-party payment processors (such as Stripe) to handle payments. By providing payment information, you agree to the terms and conditions of our payment processors.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-semibold text-white">9. Service Availability and Modifications</h2>
            <p className="mb-4 leading-7">
              We strive to provide reliable service but do not guarantee that the Service will be available at all times or free from errors, interruptions, or security vulnerabilities. We may:
            </p>
            <ul className="mb-4 ml-6 list-disc space-y-2 leading-7">
              <li>Perform scheduled maintenance that may temporarily interrupt service</li>
              <li>Modify, update, or discontinue features of the Service</li>
              <li>Impose usage limits or restrictions</li>
              <li>Suspend or terminate access for violations of these Terms</li>
            </ul>
            <p className="leading-7">
              We are not liable for any loss or damage resulting from service interruptions or modifications.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-semibold text-white">10. Disclaimers and Limitations of Liability</h2>
            <p className="mb-4 leading-7">
              <strong>THE SERVICE IS PROVIDED "AS IS" AND "AS AVAILABLE" WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, OR NON-INFRINGEMENT.</strong>
            </p>
            <p className="mb-4 leading-7">
              To the maximum extent permitted by law, LinkDrop and its affiliates, officers, employees, and agents shall not be liable for any indirect, incidental, special, consequential, or punitive damages, including but not limited to loss of profits, data, or business opportunities, arising out of or related to your use of the Service.
            </p>
            <p className="leading-7">
              Our total liability for any claims arising from or related to the Service shall not exceed the amount you paid us in the twelve (12) months preceding the claim, or $100, whichever is greater.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-semibold text-white">11. Indemnification</h2>
            <p className="leading-7">
              You agree to indemnify, defend, and hold harmless LinkDrop and its affiliates, officers, employees, and agents from any claims, damages, losses, liabilities, and expenses (including reasonable attorneys' fees) arising out of or related to: (a) your use of the Service, (b) Your Content, (c) your violation of these Terms, or (d) your violation of any rights of another party.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-semibold text-white">12. Termination</h2>
            <p className="mb-4 leading-7">
              You may terminate your account at any time by contacting us or using account deletion features if available. We may suspend or terminate your account immediately, without prior notice, if you violate these Terms or engage in fraudulent, abusive, or illegal activity.
            </p>
            <p className="leading-7">
              Upon termination, your right to use the Service will cease immediately. We may delete Your Content and account data, though we reserve the right to retain certain information as required by law or for legitimate business purposes. We are not obligated to provide you with a copy of Your Content upon termination.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-semibold text-white">13. Governing Law and Dispute Resolution</h2>
            <p className="mb-4 leading-7">
              These Terms shall be governed by and construed in accordance with the laws of the jurisdiction in which LinkDrop operates, without regard to its conflict of law provisions.
            </p>
            <p className="leading-7">
              Any disputes arising out of or relating to these Terms or the Service shall be resolved through binding arbitration in accordance with applicable arbitration rules, except where prohibited by law. You waive any right to participate in a class-action lawsuit or class-wide arbitration.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-semibold text-white">14. Changes to Terms</h2>
            <p className="leading-7">
              We reserve the right to modify these Terms at any time. We will notify you of material changes by posting the updated Terms on our website and updating the "Last updated" date. Your continued use of the Service after such modifications constitutes your acceptance of the updated Terms. If you do not agree to the modified Terms, you must stop using the Service.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-semibold text-white">15. Miscellaneous</h2>
            <p className="mb-4 leading-7">
              <strong>Entire Agreement:</strong> These Terms, together with our <Link href="/privacy" className="text-white underline hover:text-white/80">Privacy Policy</Link>, constitute the entire agreement between you and LinkDrop regarding the Service.
            </p>
            <p className="mb-4 leading-7">
              <strong>Severability:</strong> If any provision of these Terms is found to be unenforceable, the remaining provisions will remain in full effect.
            </p>
            <p className="mb-4 leading-7">
              <strong>Waiver:</strong> Our failure to enforce any provision of these Terms does not constitute a waiver of that provision.
            </p>
            <p className="mb-4 leading-7">
              <strong>Assignment:</strong> You may not assign or transfer these Terms or your account without our prior written consent. We may assign these Terms without restriction.
            </p>
            <p className="leading-7">
              <strong>Contact:</strong> If you have questions about these Terms, please contact us at hi@lnkdrp.com.
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
