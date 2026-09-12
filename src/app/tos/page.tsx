/**
 * Terms of Service page.
 *
 * Public terms of service page, linked from the shared public footer.
 *
 * Keep this in step with what the app actually does. The Privacy Policy (`/privacy`) carries the
 * data-handling detail; this page covers the contract. `LAST_UPDATED` is a fixed date, bumped by
 * hand whenever the wording changes, never the render date.
 */
/* eslint-disable react/no-unescaped-entities */
"use client";

import Link from "next/link";
import PublicFooter from "@/components/PublicFooter";
import PublicHeader from "@/components/PublicHeader";

const LAST_UPDATED = "September 12, 2026";

/**
 * Render the TermsOfServicePage UI.
 */
export default function TermsOfServicePage() {
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

        <div className="mx-auto w-full max-w-3xl px-6 pb-12 pt-12 md:pt-16">
        <h1 className="mb-2 text-3xl font-semibold tracking-tight text-white">Terms of Service</h1>
        <p className="mb-12 text-sm text-white/60">Last updated: {LAST_UPDATED}</p>

        <div className="space-y-8 text-sm leading-7 text-[#b3b3bb]">
          <section>
            <h2 className="mb-3 text-base font-semibold text-white">1. Acceptance of Terms</h2>
            <p className="mb-4 leading-7">
              By accessing or using LinkDrop ("the Service"), you agree to be bound by these Terms of Service ("Terms"). If you do not agree to these Terms, you may not access or use the Service.
            </p>
            <p className="leading-7">
              LinkDrop is a document sharing platform for uploading PDF documents, sharing them through trackable links, and reviewing them with AI. The Service is provided by LinkDrop ("we," "us," or "our").
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-base font-semibold text-white">2. Description of Service</h2>
            <p className="mb-4 leading-7">
              LinkDrop provides a platform for:
            </p>
            <ul className="mb-4 ml-6 list-disc space-y-2 leading-7">
              <li>Uploading and storing PDF documents, including documents imported from a URL you provide</li>
              <li>Creating share links for documents, with optional password protection and control over whether recipients can download the PDF</li>
              <li>Organizing documents into projects, and collecting documents from other people through request links</li>
              <li>AI-generated summaries, reviews, and version comparisons of your documents, shown to you and, for summaries and key points, to the people you share with</li>
              <li>Tracking how shared documents are viewed: views, pages read, time spent, and downloads</li>
              <li>Team workspaces where members share documents, projects, and a billing plan</li>
              <li>Email notifications about document activity and request-link submissions, which you can turn off in your settings</li>
            </ul>
            <p className="mb-4 leading-7">
              Programmatic access for AI agents and other software (for example over MCP, an API, or a CLI) is made available as we release it. When it is, the same Terms apply to anything an agent does on your behalf, and you are responsible for the agent's actions under your account.
            </p>
            <p className="leading-7">
              We reserve the right to modify, suspend, or discontinue any aspect of the Service at any time, with or without notice.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-base font-semibold text-white">3. Accounts and Access</h2>
            <p className="mb-4 leading-7">
              Accounts are created by signing in with Google. We do not issue passwords. You are responsible for:
            </p>
            <ul className="mb-4 ml-6 list-disc space-y-2 leading-7">
              <li>Keeping your Google account secure, since anyone who can sign in to it can access your LinkDrop account</li>
              <li>All activity that occurs under your account, including activity by team members you invite and by agents or software you connect</li>
              <li>Notifying us promptly at hi@lnkdrp.com of any unauthorized use of your account</li>
            </ul>
            <p className="mb-4 leading-7">
              Some parts of the Service can be used without signing in. In that case we create a lightweight anonymous identity stored in your browser. Anything you create that way is tied to that browser until you sign in and claim it, and we cannot recover it for you if the browser data is cleared.
            </p>
            <p className="leading-7">
              You must be at least 13 years old, or the minimum age required in your jurisdiction, to use the Service. We reserve the right to suspend or terminate accounts that violate these Terms or engage in fraudulent, abusive, or illegal activity.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-base font-semibold text-white">4. Acceptable Use</h2>
            <p className="mb-4 leading-7">
              You agree not to use the Service to:
            </p>
            <ul className="mb-4 ml-6 list-disc space-y-2 leading-7">
              <li>Upload, share, or distribute any content that is illegal, harmful, threatening, abusive, harassing, defamatory, or otherwise objectionable</li>
              <li>Violate any applicable laws or regulations</li>
              <li>Infringe upon the intellectual property rights of others</li>
              <li>Upload malicious software, viruses, or other harmful code</li>
              <li>Attempt to gain unauthorized access to the Service or other users' accounts, documents, or workspaces</li>
              <li>Use share links, request links, or email notifications for spam, phishing, or other fraudulent activities</li>
              <li>Circumvent rate limits, password protection, download restrictions, or credit limits</li>
              <li>Interfere with or disrupt the Service or servers connected to the Service</li>
              <li>Reverse engineer, decompile, or disassemble any part of the Service</li>
            </ul>
          </section>

          <section>
            <h2 className="mb-3 text-base font-semibold text-white">5. Content and Intellectual Property</h2>
            <p className="mb-4 leading-7">
              <strong>Your Content:</strong> You retain ownership of any documents, data, or content you upload to the Service ("Your Content"). By uploading Your Content, you grant us a limited, non-exclusive license to store, process, and display Your Content solely for the purpose of providing the Service to you. That processing includes extracting text and page images from your PDFs and sending them to our AI provider to generate summaries, reviews, and comparisons.
            </p>
            <p className="mb-4 leading-7">
              <strong>Content You Receive:</strong> Documents that other people submit to you through a request link, or that you save from a share link into your own account, are stored in your workspace. You are responsible for handling them in line with any obligations you owe to the person who sent them.
            </p>
            <p className="mb-4 leading-7">
              <strong>Our Content:</strong> The Service, including its design, features, functionality, and all related software, is owned by LinkDrop and protected by copyright, trademark, and other intellectual property laws. You may not copy, modify, distribute, or create derivative works based on the Service without our express written permission.
            </p>
            <p className="leading-7">
              <strong>AI-Generated Content:</strong> The Service uses artificial intelligence to analyze, summarize, review, and compare your documents, and to extract details such as company names and contact information from documents submitted through request links. AI-generated content can be wrong or incomplete. It is provided for informational purposes only and should not be relied upon as professional, legal, financial, or investment advice.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-base font-semibold text-white">6. Privacy and Data Protection</h2>
            <p className="mb-4 leading-7">
              Your privacy is important to us. Our collection, use, and protection of your personal information is governed by our <Link href="/privacy" className="text-white/80 underline hover:text-white">Privacy Policy</Link>, which is incorporated into these Terms by reference. By using the Service, you consent to the collection and use of your information as described in our Privacy Policy.
            </p>
            <p className="leading-7">
              You are responsible for ensuring that any documents you upload comply with applicable data protection laws and that you have the necessary rights and consents to store them, share them, and have them processed by AI through the Service.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-base font-semibold text-white">7. Sharing, Public Links, and Viewer Tracking</h2>
            <p className="mb-4 leading-7">
              The Service allows you to create share links for your documents. Anyone with a share link can open the document unless you set a password. You are solely responsible for:
            </p>
            <ul className="mb-4 ml-6 list-disc space-y-2 leading-7">
              <li>Who you share your links with</li>
              <li>Setting appropriate password protection and download controls</li>
              <li>The content of documents you choose to share, including the AI summary shown alongside them</li>
              <li>Complying with any confidentiality obligations related to shared documents</li>
            </ul>
            <p className="mb-4 leading-7">
              When someone opens your share link, the Service records how they interact with the document (pages viewed, time spent, and downloads) and shows that activity to you. Their IP address is also recorded for security purposes but is not shown to you. Viewers may also choose to give their name and email, which is shown to you. If a viewer requests a download you have not enabled, you decide whether to approve it, and the viewer must sign in to receive the file. By using share links you agree to use this viewer information lawfully and only for purposes connected to the document you shared.
            </p>
            <p className="leading-7">
              We are not responsible for unauthorized access to your documents that results from your failure to secure your share links or account credentials.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-base font-semibold text-white">8. Plans, Credits, and Billing</h2>
            <p className="mb-4 leading-7">
              The Service has a Free plan and a paid Pro plan. Plans are bound to a workspace, not to an individual, and one Pro subscription covers every member of that workspace.
            </p>
            <p className="mb-4 leading-7">
              <strong>Credits:</strong> AI features consume credits. Each AI action has a fixed credit cost shown on our <Link href="/pricing" className="text-white/80 underline hover:text-white">pricing page</Link>. Free workspaces receive a one-time starter balance. Pro workspaces receive an included credit allowance at the start of each billing cycle; unused included credits do not roll over. When credits run out, AI features pause but your documents, share links, and tracking keep working.
            </p>
            <p className="mb-4 leading-7">
              <strong>On-demand credits:</strong> Pro workspaces can optionally enable on-demand credits beyond the included allowance. On-demand usage is metered and billed at the published per-credit rate, and is always capped by a spend limit you set. On-demand is off by default.
            </p>
            <p className="mb-4 leading-7">
              If you purchase a Pro subscription:
            </p>
            <ul className="mb-4 ml-6 list-disc space-y-2 leading-7">
              <li>The subscription fee is billed in advance on a recurring basis (currently monthly); on-demand credits, if enabled, are billed in arrears based on metered usage</li>
              <li>All fees are non-refundable except as required by law</li>
              <li>We reserve the right to change plan prices and credit costs with 30 days' notice</li>
              <li>Your subscription will automatically renew unless cancelled before the renewal date</li>
              <li>You may cancel at any time through the billing portal; cancellation takes effect at the end of the current billing period, after which the workspace returns to the Free plan</li>
            </ul>
            <p className="leading-7">
              We use Stripe to handle payments. Your card details are entered on and stored by Stripe, not by us. By providing payment information, you agree to Stripe's terms and conditions.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-base font-semibold text-white">9. Service Availability and Modifications</h2>
            <p className="mb-4 leading-7">
              We strive to provide reliable service but do not guarantee that the Service will be available at all times or free from errors, interruptions, or security vulnerabilities. We may:
            </p>
            <ul className="mb-4 ml-6 list-disc space-y-2 leading-7">
              <li>Perform scheduled maintenance that may temporarily interrupt service</li>
              <li>Modify, update, or discontinue features of the Service</li>
              <li>Impose usage limits, rate limits, file size limits, or credit limits</li>
              <li>Suspend or terminate access for violations of these Terms</li>
            </ul>
            <p className="leading-7">
              We are not liable for any loss or damage resulting from service interruptions or modifications.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-base font-semibold text-white">10. Disclaimers and Limitations of Liability</h2>
            <p className="mb-4 leading-7">
              THE SERVICE IS PROVIDED "AS IS" AND "AS AVAILABLE" WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, OR NON-INFRINGEMENT.
            </p>
            <p className="mb-4 leading-7">
              To the maximum extent permitted by law, LinkDrop and its affiliates, officers, employees, and agents shall not be liable for any indirect, incidental, special, consequential, or punitive damages, including but not limited to loss of profits, data, or business opportunities, arising out of or related to your use of the Service, including reliance on AI-generated content.
            </p>
            <p className="leading-7">
              Our total liability for any claims arising from or related to the Service shall not exceed the amount you paid us in the twelve (12) months preceding the claim, or $100, whichever is greater.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-base font-semibold text-white">11. Indemnification</h2>
            <p className="leading-7">
              You agree to indemnify, defend, and hold harmless LinkDrop and its affiliates, officers, employees, and agents from any claims, damages, losses, liabilities, and expenses (including reasonable attorneys' fees) arising out of or related to: (a) your use of the Service, (b) Your Content, (c) your violation of these Terms, or (d) your violation of any rights of another party.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-base font-semibold text-white">12. Termination</h2>
            <p className="mb-4 leading-7">
              You may stop using the Service at any time. To close your account, contact us at hi@lnkdrp.com; we do not currently offer self-service account deletion. We may suspend or terminate your account immediately, without prior notice, if you violate these Terms or engage in fraudulent, abusive, or illegal activity.
            </p>
            <p className="leading-7">
              Upon termination, your right to use the Service will cease and your share links will stop working. We may delete Your Content and account data, though we reserve the right to retain certain information as required by law or for legitimate business purposes (for example, billing records). We are not obligated to provide you with a copy of Your Content upon termination, so download anything you need beforehand.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-base font-semibold text-white">13. Governing Law and Dispute Resolution</h2>
            <p className="mb-4 leading-7">
              These Terms shall be governed by and construed in accordance with the laws of the jurisdiction in which LinkDrop operates, without regard to its conflict of law provisions.
            </p>
            <p className="leading-7">
              Any disputes arising out of or relating to these Terms or the Service shall be resolved through binding arbitration in accordance with applicable arbitration rules, except where prohibited by law. You waive any right to participate in a class-action lawsuit or class-wide arbitration.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-base font-semibold text-white">14. Changes to Terms</h2>
            <p className="leading-7">
              We reserve the right to modify these Terms at any time. We will notify you of material changes by posting the updated Terms on our website and updating the "Last updated" date. Your continued use of the Service after such modifications constitutes your acceptance of the updated Terms. If you do not agree to the modified Terms, you must stop using the Service.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-base font-semibold text-white">15. Miscellaneous</h2>
            <p className="mb-4 leading-7">
              <strong>Entire Agreement:</strong> These Terms, together with our Privacy Policy, constitute the entire agreement between you and LinkDrop regarding the Service.
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
        <PublicFooter className="relative pb-6" containerClassName="mx-auto w-full max-w-3xl px-6" />
      </div>
    </main>
  );
}
