import { useState } from "react";
import { Pressable, View } from "react-native";
import { useKycDraft } from "@/components/manage/kyc-draft";
import { Glyph } from "@/components/ui/glyph";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { SkeletonCard } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useResource } from "@/hooks/use-resource";
import { getKycAgreement, KYC_AGREEMENT_PDF_PATH, signKycAgreement } from "@/lib/admin-api";
import { SignatureInk, SignaturePad } from "@/components/signature-pad";
import { downloadToDevice } from "@/lib/documents";
import { isSignatureComplete, signatureStrokes } from "@/lib/signature";
import { API_BASE_URL } from "@/lib/api";
import { readApiError } from "@/lib/api-contract";
import { toastError } from "@/lib/toast";

/**
 * The service agreement, read in full on the page and signed at its foot: full
 * name, drawn signature, a tick. The wizard's footer signs it. It can be
 * signed again until it is issued on approval — then it is final, emailed as
 * a PDF, and downloadable here.
 */
export function AgreementStep({ onSaved, onSigningChange }: { onSaved: () => Promise<void> | void; onSigningChange: (active: boolean) => void }) {
  const { colors } = useAppTheme();
  const agreement = useResource(getKycAgreement, { cacheKey: "kyc-agreement" });
  const [again, setAgain] = useState(false);
  const [name, setName] = useState("");
  const [signature, setSignature] = useState("");
  const [agree, setAgree] = useState(false);
  const [saving, setSaving] = useState(false);
  const data = agreement.data;
  const signed = data?.signed && !again ? data.signed : null;
  const save = async () => {
    if (name.trim().length < 2 || !isSignatureComplete(signature) || !agree) {
      toastError("Not signed", "Type your full name, sign in the box and tick that you agree.");
      return false;
    }
    setSaving(true);
    try { await signKycAgreement({ signature, signerName: name.trim() }); await agreement.reload(); await onSaved(); setAgain(false); return true; }
    catch (error) { toastError("Not signed", readApiError(error)); return false; }
    finally { setSaving(false); }
  };
  useKycDraft({ dirty: !signed && Boolean(name.trim() || signature || agree), busy: saving, save });

  if (!data) return agreement.error ? <ErrorState message={agreement.error} onRetry={agreement.reload} /> : <SkeletonCard />;

  return <View className="gap-4">
    <Card className="gap-3">
      <Text variant="subtitle">{data.title}</Text>
      <Text variant="muted">{data.intro}</Text>
      {data.terms.map(section => <View className="gap-1.5" key={section.heading}>
        <Text variant="label">{section.heading}</Text>
        {section.points.map(point => <View className="flex-row gap-2" key={point}><Text variant="body">•</Text><Text className="flex-1" variant="body">{point}</Text></View>)}
      </View>)}
    </Card>
    {signed ? <Card className="gap-3">
      <SignatureInk color={colors.foreground} height={80} strokes={signatureStrokes(signed.signature)} width={240} />
      <Text variant="body">Signed by {signed.signerName} on {new Date(signed.signedAt).toLocaleDateString("en-GB")}</Text>
      {signed.refCode
        ? <Button label={`Download agreement ${signed.refCode}`} onPress={() => void downloadToDevice({ extension: "pdf", fileName: `HostelPalika-Agreement-${signed.refCode!.replace(/\//g, "-")}`, label: "Agreement", mimeType: "application/pdf", url: `${API_BASE_URL}${KYC_AGREEMENT_PDF_PATH}` }).catch(error => toastError("Not downloaded", readApiError(error)))} />
        : <><Text variant="muted">We email you the signed PDF when your KYC is approved.</Text><Button label="Sign again" variant="ghost" onPress={() => setAgain(true)} /></>}
    </Card> : <View className="gap-4">
      <Input autoCapitalize="words" autoComplete="name" leading={<Glyph color={colors.mutedForeground} name="person" size={18} />} variant="line" label="Your full name" onChangeText={setName} value={name} />
      <SignaturePad onActiveChange={onSigningChange} onChange={setSignature} value={signature} />
      <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: agree }} onPress={() => setAgree(!agree)} className="min-h-12 flex-row items-center gap-3">
        <Glyph name={agree ? "checkmark-circle" : "ellipse"} color={agree ? colors.primary : colors.mutedForeground} size={24} />
        <Text className="flex-1" variant="body">I have read this agreement and I agree to it.</Text>
      </Pressable>
    </View>}
  </View>;
}
