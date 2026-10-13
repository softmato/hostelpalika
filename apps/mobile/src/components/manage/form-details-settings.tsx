import { useState } from "react";
import { View } from "react-native";

import { Badge } from "@/components/ui/badge";
import { Card, SectionHeader } from "@/components/ui/card";
import { ListRow, RowDivider } from "@/components/ui/list-row";
import { SkeletonCard } from "@/components/ui/skeleton";
import { Toggle } from "@/components/ui/toggle";
import { useResource } from "@/hooks/use-resource";
import { type AdmissionFormLink, updateAdmissionFormSettings } from "@/lib/admission-form-api";
import { adminQuery } from "@/lib/admin-queries";
import { readApiError } from "@/lib/api-contract";
import { toastError } from "@/lib/toast";

/**
 * Settings → Form details: which documents the admission form asks for.
 *
 * Their own citizenship or ID is always required. The guardian's is optional
 * until this is turned on, and then the form — the Form QR and the warden's
 * no-card form alike — will not send without it. Wardens and owners can both
 * change it (`registerResidents`); an account without that grant sees nothing.
 */
export function FormDetailsSettings() {
  const query = adminQuery.admissionFormLink();
  const link = useResource<AdmissionFormLink>(query.load, { cacheKey: query.key, topics: query.topics });
  const [saving, setSaving] = useState(false);

  if (link.loading) {
    return <SkeletonCard rows={2} />;
  }

  if (!link.data) {
    return null;
  }

  async function setGuardianRequired(guardianDocRequired: boolean) {
    setSaving(true);

    try {
      const next = await updateAdmissionFormSettings({ guardianDocRequired });

      link.setData(() => next);
    } catch (error) {
      toastError("Not saved", readApiError(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <View>
      <SectionHeader subtitle="What the admission form asks for" title="Form details" />
      <Card padding="px-4 py-1">
        <ListRow
          icon="card-outline"
          right={<Badge label="Required" tone="success" />}
          subtitle="Their citizenship or ID — always asked"
          title="Resident's ID document"
        />
        <RowDivider inset />
        <ListRow
          icon="people-outline"
          right={
            <Toggle
              accessibilityLabel="Guardian's ID document required"
              disabled={saving}
              onChange={(value) => void setGuardianRequired(value)}
              value={Boolean(link.data.guardianDocRequired)}
            />
          }
          subtitle={
            link.data.guardianDocRequired
              ? "Required — the form will not send without it"
              : "Optional — turn on to make it required"
          }
          title="Guardian's ID document"
        />
      </Card>
    </View>
  );
}
