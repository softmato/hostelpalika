import { DocumentScreen } from "@/components/document-screen";

/**
 * The privacy policy, in the app.
 *
 * It used to be `WebBrowser.openBrowserAsync(`${API_BASE_URL}/privacy`)` from
 * Settings — the only "read the policy" affordance the phone had, and it left
 * the app to answer a question the app had raised. The argument for the browser
 * was that a legal document should show its address; the argument against is
 * that a Chrome Custom Tab over a green app is a context switch mid-flow, and
 * the website is still there for anyone who wants the URL.
 *
 * The text comes from the platform's own configuration, so this is the same
 * document the website serves at `/privacy`.
 */
export default function PrivacyPolicyScreen() {
  return (
    <DocumentScreen
      icon="shield-checkmark"
      legalDocument="privacy"
      page="privacy"
      webPath="privacy"
      title="Privacy Policy"
    />
  );
}
