import { useLocalSearchParams } from "expo-router";

import { OverallTopicScreen } from "@/components/overall-views";

/** One subject over every branch, opened from the Overall Home's tiles. */
export default function OverallTopicRoute() {
  const { topic } = useLocalSearchParams<{ topic: string }>();

  return <OverallTopicScreen topic={topic ?? ""} />;
}
