import { Stack } from "expo-router";

import { StoreCartProvider } from "@/components/store/store-cart";

export default function StoreDetailLayout() {
  return (
    <StoreCartProvider>
      <Stack
        screenOptions={{
          animation: "fade",
          animationDuration: 150,
          headerShown: false,
        }}
      >
        <Stack.Screen name="product/[id]" />
        <Stack.Screen name="category/[slug]" />
        <Stack.Screen name="order/[id]" />
        <Stack.Screen
          name="checkout"
          options={{ animation: "slide_from_bottom" }}
        />
      </Stack>
    </StoreCartProvider>
  );
}
