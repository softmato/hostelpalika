import { View } from "react-native";
import { Badge } from "@/components/ui/badge";
import { Text } from "@/components/ui/text";

export function NoticeReader({
  title,
  content,
  category,
  urgent,
  date,
}: {
  title: string;
  content: string;
  category?: string;
  urgent?: boolean;
  date?: string;
}) {
  return (
    <View className="gap-5 pb-4">
      <View className="flex-row flex-wrap items-center gap-2">
        {category ? <Badge label={category} /> : null}
        {urgent ? <Badge label="Urgent" tone="danger" /> : null}
        {date ? <Text variant="caption">{date}</Text> : null}
      </View>
      <Text variant="title">{title}</Text>
      <View className="h-1 w-10 rounded-full bg-primary" />
      <Text selectable style={{ lineHeight: 26 }}>
        {content}
      </Text>
    </View>
  );
}
