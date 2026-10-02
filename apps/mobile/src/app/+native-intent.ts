export function redirectSystemPath({ path }: { path: string; initial: boolean }) {
  try {
    return new URL(path, "hostelpalika:///").hostname === "expo-sharing"
      ? "/share-payment"
      : path;
  } catch { return path; }
}
